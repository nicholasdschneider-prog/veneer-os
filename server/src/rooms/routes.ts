import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { createRoomService, RoomError } from "./service.js";
export function createRoomsRouter(ctx: AppContext) {
  const router = express.Router(),
    s = createRoomService(ctx.db);
  const actor = (req: express.Request) => ({
    user: req.user!,
    conversationId: req.agentConversationId,
  });
  const run =
    (fn: (req: express.Request, res: express.Response) => unknown) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((e) => {
          if (e instanceof RoomError)
            res.status(e.status).json({ error: e.message });
          else if (e instanceof z.ZodError)
            res
              .status(400)
              .json({ error: e.issues.map((i) => i.message).join("; ") });
          else next(e);
        });
    };
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/",
    run((req, res) => res.json({ rooms: s.list(actor(req)) })),
  );
  router.get(
    "/directory",
    run((req, res) => res.json(s.directory(actor(req)))),
  );
  router.post(
    "/",
    run((req, res) => res.json({ room: s.create(actor(req), req.body) })),
  );
  router.get(
    "/:id",
    run(async (req, res) => {
      const after = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(req.query.after ?? 0);
      const id = String(req.params.id);
      const room = s.read(actor(req), id, after);
      await Promise.all(room.bot_activity.map(async activity => {
        const worker = ctx.db.prepare(`SELECT w.conversation_id FROM team_room_workers w
          JOIN team_room_members m ON m.room_id=w.room_id AND m.bot_id=w.bot_id AND m.epoch=w.bot_epoch
          WHERE w.room_id=? AND w.bot_id=? AND m.left_at IS NULL`).get(id, activity.bot_key.slice(4)) as {conversation_id: string} | undefined;
        if (!worker) return;
        try {
          const status = await ctx.manager.statusOf(worker.conversation_id);
          if (status === 'failed') activity.state = 'failed';
          else if (status === 'needs_you') activity.state = 'waiting';
          else if (status === 'working') activity.state = 'working';
        } catch {
          // Durable queue/recovery state remains useful during runner restarts.
        }
      }));
      // Access may have changed during the runner round trip.
      const fresh = s.read(actor(req), id, after);
      for (const activity of fresh.bot_activity) {
        const observed = room.bot_activity.find(old => old.bot_key === activity.bot_key && old.message_id === activity.message_id);
        if (observed) activity.state = observed.state;
      }
      res.json({ room: fresh });
    }),
  );
  router.patch(
    "/:id",
    run((req, res) =>
      res.json(s.update(actor(req), String(req.params.id), req.body)),
    ),
  );
  router.post('/:id/invite', run((req, res) =>
    res.json({ room: s.invite(actor(req), String(req.params.id), req.body) }),
  ));
  router.post(
    "/:id/messages",
    run((req, res) =>
      res.json(s.post(actor(req), String(req.params.id), req.body)),
    ),
  );
  router.post(
    "/:id/seen",
    run((req, res) => {
      const p = z
        .object({ seq: z.number().int().nonnegative() })
        .strict()
        .parse(req.body);
      s.seen(actor(req), String(req.params.id), p.seq);
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:id/files",
    (req, res, next) => {
      try {
        s.access(actor(req), String(req.params.id), true);
        if (req.agentConversationId)
          throw new RoomError(403, "Bot room replies are text-only.");
        next();
      } catch (e) {
        res
          .status(e instanceof RoomError ? e.status : 403)
          .json({ error: "Attachment access denied." });
      }
    },
    express.raw({ type: "application/octet-stream", limit: "20mb" }),
    run((req, res) => {
      const a = actor(req),
        room = String(req.params.id);
      s.access(a, room, true);
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new RoomError(400, "Choose a nonempty file up to 20 MB.");
      const name = z
        .string()
        .trim()
        .min(1)
        .max(180)
        .parse(req.query.name)
        .replace(/[\x00-\x1f/\\]/g, "_");
      const id = crypto.randomUUID(),
        folder = path.join(ctx.config.dataDir, "room-files");
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const target = path.join(folder, id);
      fs.writeFileSync(target, req.body, { flag: "wx", mode: 0o600 });
      try {
        ctx.db
          .prepare(
            "INSERT INTO team_room_files(id,room_id,uploader_key,name,storage_path,size) VALUES(?,?,?,?,?,?)",
          )
          .run(id, room, s.actorKey(a), name, target, req.body.length);
      } catch (e) {
        fs.unlinkSync(target);
        throw e;
      }
      res.json({ file: s.file(a, room, id) });
    }),
  );
  router.get(
    "/:id/files/:fileId",
    run((req, res) => {
      const file = s.file(
        actor(req),
        String(req.params.id),
        String(req.params.fileId),
      );
      const row = ctx.db
        .prepare("SELECT storage_path FROM team_room_files WHERE id=?")
        .get(file.id) as { storage_path: string };
      res.set("X-Content-Type-Options", "nosniff");
      // Only raster images may render inline; active documents remain downloads.
      const imageTypes: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
      };
      const imageType = imageTypes[path.extname(file.name).toLowerCase()];
      if (req.query.inline === '1' && imageType) {
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        res.type(imageType);
        res.set('Content-Disposition', 'inline');
        res.sendFile(row.storage_path);
      } else {
        res.type("application/octet-stream");
        res.download(row.storage_path, file.name);
      }
    }),
  );
  return router;
}
