-- One-off, owner-directed data change (James thread cc590792 turn 4, following
-- Nick's 2026-10-13 instruction): flatten ERVP Customer Service and retire
-- Grant's stale cards. Every statement is pinned to exact rows and is a no-op
-- on any other install. It writes no wakeups, drafts, leases or deliveries.

-- 1) Roster: the five CS bots keep their subteam but no longer report to Grant;
-- Grant becomes a plain bot outside any subteam. No other member changes.
UPDATE business_bot_members SET reports_to=NULL
WHERE team_id='5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86'
  AND reports_to='cb4ade24-c960-4235-956a-220260e5adac'
  AND role='bot' AND subteam='Customer Service'
  AND conversation_id IN (
    'e9fe9b64-9b75-4280-b795-42158ae9cf16',
    '8540bd53-1a6f-440e-a136-4a4c7ac7f940',
    '1e96b7bb-1071-4f1d-b710-310f9fbbc9e1',
    '26c325f7-32de-46ec-80f1-1c28e75d4b37',
    '170ab267-448c-4b13-97f4-5f24db2f3652');
UPDATE business_bot_members SET role='bot',subteam='',reports_to=NULL
WHERE team_id='5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86'
  AND conversation_id='cb4ade24-c960-4235-956a-220260e5adac' AND role='lead'
  AND NOT EXISTS (SELECT 1 FROM business_bot_members
    WHERE reports_to='cb4ade24-c960-4235-956a-220260e5adac');

-- 2) Grant's 42 parked cards, handed to their case owners with acknowledgment on
-- 2026-09-29, are withdrawn administratively. The approve answer moves under
-- prior_answer so it no longer authorizes anything; result_json and parked_json
-- are untouched, and the original answered event stays in the immutable audit.
CREATE TEMP TABLE grant_cs_withdraw(id TEXT PRIMARY KEY);
INSERT INTO grant_cs_withdraw(id) VALUES
  ('e74dfdc8-fb4e-403a-b801-cabaa2a55dfc'),
  ('668de9d7-0163-454e-b1a7-68a1c0d97a17'),
  ('e1873e7e-9906-474c-94a6-c4ba9be66a58'),
  ('3db1a80a-7055-480a-ba1e-76bd2a910984'),
  ('9f799f53-c8f8-4daa-ae7b-427a0a4b004d'),
  ('aa8ea1b9-5f31-46be-ada0-c566e3f1d2a1'),
  ('8859b06f-84d5-456e-bc37-8506bf5d1414'),
  ('2d12f3e6-d1a0-4432-94f7-e28ef8df5d1e'),
  ('c1e15f53-d07a-473f-a7a3-2009481e1800'),
  ('2d812eb5-6ba0-4ed1-a79d-e8b80ac741b4'),
  ('e28a569f-e05f-42bd-ad05-da962b65b5c4'),
  ('e21edf30-90c2-4672-ac69-3962bb66c1bc'),
  ('62fcf331-2dfa-4274-9a51-cc5afac724fd'),
  ('a682a99f-75ee-4f5f-930e-e15386e5814c'),
  ('52dfe92a-752d-40e3-98e5-1e1735f2fc7c'),
  ('402be67f-77d1-42f8-9673-d2e29a9e914b'),
  ('5e78f3a2-f0c1-42df-a236-c3882a53c320'),
  ('ccc8a03c-1945-4d55-9c3f-f28592c358a6'),
  ('002d2938-96c8-4dcd-9072-46a6a13e2f5a'),
  ('51063e3e-701c-4457-bf26-c744c9da169b'),
  ('c28c3d5f-6d6d-4e21-8186-094fafebfa5f'),
  ('806b56a0-dc69-4031-8871-d11ca1fd6e17'),
  ('79d8fbca-8545-4ed9-88e4-26fa6db62dfc'),
  ('9acba3ae-8c9a-4a41-b893-6b011f09fe88'),
  ('4c312126-f57f-458d-9613-21591be3731b'),
  ('ab2a1ec6-4fa1-42ae-85f0-afa44c9fe697'),
  ('aef462ce-1814-4e4e-888f-24f75d1d7141'),
  ('748d335e-1aca-4281-9e4c-a80a5e2c0c43'),
  ('addc9cfc-83a4-452d-9145-a60123822826'),
  ('c929086e-0a52-4227-a46c-6ee779c72eb3'),
  ('1cd874e7-a947-485d-b4f2-057d02fec2f9'),
  ('2bd6e251-f6f9-40b0-92c0-fe9ef0db83ea'),
  ('2a4fd5ec-ef3c-4489-a668-20d97cff0aab'),
  ('7c75838d-5702-46bd-863a-25d228ac8ed5'),
  ('9c32e60d-ecdd-46ab-9afd-fb3a11541f03'),
  ('f09f7b0b-84cb-4892-a761-2dc56673da0e'),
  ('72a0f7f6-9c2a-4c66-8f2d-39ceb5cbe2c8'),
  ('88cdb4a7-b965-48bf-b453-7d4d0b9f2e32'),
  ('638f12cf-f5fc-419f-b654-8164a2245a45'),
  ('d1876d12-70af-45fe-a429-1f4d080b3068'),
  ('61d71160-5b8f-4fc6-89d9-4ebb29666671'),
  ('7bc51d09-cf90-4c68-8d72-2de4cf6a7722');

INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||
         substr('89ab',1+(abs(random())%4),1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  d.id, d.version, 'answered', c.user_id, '2a466841-8a00-4626-a9e6-4e0951ed402e',
  json_object('action','withdraw',
    'text','Withdrawn administratively: Grant removed from ERVP CS (Nick 2026-10-13); case handed to owner with acknowledgment 2026-09-29; withdrawn per James thread cc590792 turn 4',
    'scope','this_case','actor_id',c.user_id,'administrative',json('true'),
    'actor','Platform Dev chat 2a466841-8a00-4626-a9e6-4e0951ed402e (owner-authenticated, build #768)',
    'prior_state',d.state,'prior_answer',json(d.answer_json)),
  'admin-withdraw:grant-cs-flatten-2026-10-13'
FROM bot_decisions d JOIN conversations c ON c.id=d.conversation_id
WHERE d.id IN (SELECT id FROM grant_cs_withdraw)
  AND d.conversation_id='cb4ade24-c960-4235-956a-220260e5adac' AND d.state='blocked';

UPDATE bot_decisions SET state='decided',updated_at=datetime('now'),
  answer_json=(SELECT e.payload_json FROM bot_decision_events e WHERE e.decision_id=bot_decisions.id
    AND e.request_key='admin-withdraw:grant-cs-flatten-2026-10-13')
WHERE id IN (SELECT id FROM grant_cs_withdraw)
  AND conversation_id='cb4ade24-c960-4235-956a-220260e5adac' AND state='blocked'
  AND EXISTS (SELECT 1 FROM bot_decision_events e WHERE e.decision_id=bot_decisions.id
    AND e.version=bot_decisions.version AND e.request_key='admin-withdraw:grant-cs-flatten-2026-10-13');

DROP TABLE grant_cs_withdraw;
