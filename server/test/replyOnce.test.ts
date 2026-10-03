import { describe, expect, it } from 'vitest';
import { BOT_TOOL_DEFINITIONS } from '../src/mcp/botTools.js';
import { BOT_FEATURES, botFeatureInstructions } from '../src/featureGuide/catalog.js';

// A bot that answers a result reply in the thread and again in its final
// response shows the human the same answer twice. Every instruction a bot
// reads about result replies has to point at one answer.
describe('answering a result reply once', () => {
  it('tells bots the thread tool is not a second place to answer', () => {
    const tool = BOT_TOOL_DEFINITIONS.find((definition) => definition.name === 'reply_message_thread')!;
    expect(tool.description).toContain('never restate it in your final response');
    expect(tool.description).toContain('answer in your normal final response instead of this tool');
  });

  it('gives resumed and new bots the same rule through the capability catalog', () => {
    const instructions = botFeatureInstructions();
    expect(instructions).toContain('Answer a human result reply once, in your normal final response');
    expect(instructions).not.toContain('Use read_message_thread and reply_message_thread for the thread');
    expect(instructions).toContain('only your last one is shown as a full answer');
  });

  it('documents collapsed progress notes for employees', () => {
    const feature = BOT_FEATURES.find((entry) => entry.id === 'progress-notes')!;
    expect(feature.updated).toBe('2026-10-03');
    expect(feature.announcement).toBeTruthy();
    expect(feature.steps.length).toBeGreaterThan(0);
  });
});
