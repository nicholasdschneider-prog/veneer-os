-- Miles pilot: customer tickets owned and worked inside Veneer. OrderOps stays
-- the inbox and order system of record; a ticket here is the owning bot's own
-- durable copy of the thread, worked in a per-ticket chat (a coordination lane
-- of the owner) so the human sees the whole backstory beside every question.
CREATE TABLE cs_ticket_owners (
 conversation_id TEXT PRIMARY KEY REFERENCES bot_registrations(conversation_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE cs_tickets (
 id TEXT PRIMARY KEY,
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 orderops_ticket_id TEXT NOT NULL,
 owner_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 ticket_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
 customer_name TEXT NOT NULL DEFAULT '',
 customer_email TEXT NOT NULL DEFAULT '',
 customer_phone TEXT NOT NULL DEFAULT '',
 subject TEXT NOT NULL DEFAULT '',
 channel TEXT NOT NULL DEFAULT 'email',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting_customer','waiting_human','done')),
 orders_json TEXT NOT NULL DEFAULT '[]',
 summary TEXT NOT NULL DEFAULT '',
 last_inbound_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(team_id, orderops_ticket_id)
);
CREATE INDEX cs_tickets_owner ON cs_tickets(owner_conversation_id, status, updated_at);
CREATE UNIQUE INDEX cs_tickets_chat ON cs_tickets(ticket_conversation_id) WHERE ticket_conversation_id IS NOT NULL;
CREATE TABLE cs_ticket_messages (
 id TEXT PRIMARY KEY,
 ticket_id TEXT NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
 direction TEXT NOT NULL CHECK(direction IN ('in','out','note')),
 channel TEXT NOT NULL DEFAULT '',
 external_id TEXT,
 author TEXT NOT NULL CHECK(author IN ('customer','bot','human')),
 author_label TEXT NOT NULL DEFAULT '',
 body TEXT NOT NULL,
 attachments_json TEXT NOT NULL DEFAULT '[]',
 remember INTEGER NOT NULL DEFAULT 0 CHECK(remember IN (0,1)),
 at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX cs_ticket_messages_ticket ON cs_ticket_messages(ticket_id, at);
CREATE UNIQUE INDEX cs_ticket_messages_external ON cs_ticket_messages(ticket_id, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE bot_decisions ADD COLUMN cs_ticket_id TEXT REFERENCES cs_tickets(id) ON DELETE SET NULL;
CREATE INDEX bot_decisions_cs_ticket ON bot_decisions(cs_ticket_id);
-- Pilot enrollment (Nick, 2026-10-16): Miles owns his tickets inside Veneer.
INSERT OR IGNORE INTO cs_ticket_owners(conversation_id)
 SELECT conversation_id FROM bot_registrations WHERE conversation_id='8540bd53-1a6f-440e-a136-4a4c7ac7f940';
