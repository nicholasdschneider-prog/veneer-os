import Database from 'better-sqlite3';
import {describe,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {refuseUnregisteredChat} from '../src/bots/unregisteredChat.js';

describe('unregistered chat refusal',()=>{
 it('names ordinary chats accurately and leaves registered or deactivated bots to their own checks',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Owner','owner')").run();
  for(const id of ['plain','bot','retired'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'codex',?,'team')").run(id,id,id);
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('bot','bot',1,1),('retired','retired',0,1)").run();
  expect(()=>refuseUnregisteredChat(db,'plain')).toThrow('attached Gmail connector');
  expect(()=>refuseUnregisteredChat(db,'bot')).not.toThrow();
  expect(()=>refuseUnregisteredChat(db,'retired')).not.toThrow();
  expect(()=>refuseUnregisteredChat(db,undefined)).not.toThrow();
  db.close();
 });
});
