import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {ArcherCallSettings} from './ArcherCallSettings';
describe('Archer call setup',()=>{
  it('explains conversation, existing controls, calendar policy and no redial before activation',()=>{
    const html=renderToStaticMarkup(<ArcherCallSettings phoneEnabled={false} botEnabled={false}/>);
    expect(html).toContain('interrupt, change topics, ask questions');expect(html).toContain('new instructions');
    expect(html).toContain('Call my phone');expect(html).toContain('Archer under Bots that can call me');expect(html).toContain('Missed meeting reminders aren');
    expect(html).not.toContain('Call my phone now');expect(html).not.toContain('Enable Archer calendar calls');
  });
});
