import { FseWriter } from './fse';
describe('FSE encoder (Phase D)', () => {
  test('WriteString matches captured UiLanguage element from from-start.pcap', () => {
    // 16 81 0a "UiLanguage" 00000002 "en"
    expect(new FseWriter().string('UiLanguage', 'en').toBuffer().toString('hex'))
      .toBe('16810a55694c616e677561676500000002656e');
  });
  test('cached name reuses MRU index (shorter second time)', () => {
    const w = new FseWriter();
    const first = w.string('Genre', 'rock').toBuffer().length;
    const w2 = new FseWriter();
    w2.string('Genre', 'rock');
    const before = w2.toBuffer().length;
    w2.string('Genre', 'pop'); // reuse name -> index ref, no repeated name bytes
    const second = w2.toBuffer().length - before;
    expect(second).toBeLessThan(first); // reuse is shorter than a fresh write
  });
});
