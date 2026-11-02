import type { AppContext } from '../context.js';
import { composioCalendarExecute } from './google.js';
import { createMasterCalendar, type MasterCalendar } from './service.js';

const instances = new WeakMap<object, MasterCalendar>();
/** One calendar cache per web process, shared by the routes and the reminder push worker. */
export function masterCalendarFor(ctx: AppContext): MasterCalendar {
  let calendar = instances.get(ctx);
  if (!calendar) {
    calendar = createMasterCalendar(ctx.db, composioCalendarExecute(ctx));
    instances.set(ctx, calendar);
  }
  return calendar;
}
