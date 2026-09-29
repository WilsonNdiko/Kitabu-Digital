import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Msg { who: 'me' | 'kitabu'; text: string; suggestions?: string[] }

const WELCOME: Msg = {
  who: 'kitabu',
  text: 'Habari! Ask me anything about your records — I answer from the books on this device, so I work without internet. Every figure comes straight from your ledger, never guessed.',
  suggestions: ['Who has not paid?', 'How much did I collect this month?', 'Which houses are vacant?', 'Any payments waiting for verification?'],
};

export default function AssistantPage() {
  const [msgs, setMsgs] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setMsgs((m) => [...m, { who: 'me', text: q }]);
    setBusy(true);
    try {
      const r = await api.post('/assistant/ask', { question: q });
      setMsgs((m) => [...m, { who: 'kitabu', text: r.answer, suggestions: r.suggestions }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { who: 'kitabu', text: e.message }]);
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Ask Kitabu</h1>
      <p className="sub">Answers come from the records on this device — deterministic, offline, and under your role's permissions.</p>

      <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 90 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.who === 'me' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{
              background: m.who === 'me' ? 'var(--green, #14804a)' : 'var(--card, #fff)',
              color: m.who === 'me' ? '#fff' : 'inherit',
              border: m.who === 'me' ? 'none' : '1px solid #e2e2e2',
              borderRadius: 12, padding: '10px 14px', whiteSpace: 'pre-wrap', fontSize: 14.5, lineHeight: 1.5,
            }}>
              {m.text}
            </div>
            {m.who === 'kitabu' && m.suggestions && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {m.suggestions.map((s) => (
                  <button key={s} className="btn small secondary" onClick={() => ask(s)}>{s}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="sub">Checking your records…</div>}
        <div ref={endRef} />
      </div>

      <div style={{
        position: 'sticky', bottom: 0, maxWidth: 640, display: 'flex', gap: 8,
        background: 'var(--bg, #f7f7f5)', padding: '10px 0',
      }}>
        <input
          style={{ flex: 1 }} value={input} placeholder='e.g. "Who has not paid?" or "Nani hajalipa?"'
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask(input)}
        />
        <button className="btn" disabled={busy || !input.trim()} onClick={() => ask(input)}>Ask</button>
      </div>
    </>
  );
}
