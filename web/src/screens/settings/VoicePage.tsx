import { useEffect, useState } from 'react';
import { api, type VoiceSettings } from '../../lib/api';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsRows } from './SettingsPrimitives';

const MAX_VOCABULARY_TERMS = 50;
const MAX_VOCABULARY_TERM_LENGTH = 20;

function parseVocabularyDraft(draft: string): { terms: string[]; error: string | null } {
  const lines = draft
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tooLong = lines.find((term) => term.length > MAX_VOCABULARY_TERM_LENGTH);
  if (tooLong) {
    return {
      terms: [],
      error: `“${tooLong}” is too long. Each word or phrase can have up to ${MAX_VOCABULARY_TERM_LENGTH} characters.`,
    };
  }
  const terms = [...new Set(lines)];
  if (terms.length > MAX_VOCABULARY_TERMS) {
    return { terms, error: `Use no more than ${MAX_VOCABULARY_TERMS} words or phrases.` };
  }
  return { terms, error: null };
}

function sameTerms(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((term, index) => term === right[index]);
}

export function VoicePage({ onNavigate }: { onNavigate?: (hash: string) => void }) {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [vocabularyDraft, setVocabularyDraft] = useState('');
  const [savingVocabulary, setSavingVocabulary] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedVocabulary = parseVocabularyDraft(vocabularyDraft);
  const vocabularyChanged = settings ? !sameTerms(parsedVocabulary.terms, settings.vocabularyTerms) : false;

  useEffect(() => {
    let active = true;
    void api
      .voiceSettings()
      .then((voice) => {
        if (!active) return;
        setSettings(voice.settings);
        setVocabularyDraft(voice.settings.vocabularyTerms.join('\n'));
        setError(null);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function saveVocabulary() {
    if (!settings || savingVocabulary || parsedVocabulary.error || !vocabularyChanged) return;
    setSavingVocabulary(true);
    setStatus(null);
    setError(null);
    try {
      const result = await api.updateVoiceSettings({ ...settings, vocabularyTerms: parsedVocabulary.terms });
      setSettings(result.settings);
      setVocabularyDraft(result.settings.vocabularyTerms.join('\n'));
      setStatus('Vocabulary hints saved. New voice input will use them.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingVocabulary(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Vocabulary hints</CardTitle>
          <CardDescription>Help Soniox recognize uncommon names, brands, and technical terms.</CardDescription>
        </CardHeader>
        <CardContent>
          {settings ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5" htmlFor="voice-vocabulary-terms">
                <div className="text-base font-medium sm:text-sm">Words and phrases</div>
                <div className="text-base text-muted-foreground sm:text-sm">
                  Put one word or short phrase on each line. Letter case and hyphens are kept.
                </div>
                <textarea
                  id="voice-vocabulary-terms"
                  name="voice-vocabulary-terms"
                  value={vocabularyDraft}
                  rows={9}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={savingVocabulary}
                  aria-describedby="voice-vocabulary-help"
                  aria-invalid={parsedVocabulary.error ? true : undefined}
                  onChange={(event) => {
                    setVocabularyDraft(event.target.value);
                    setStatus(null);
                  }}
                  className="w-full resize-y rounded-xl border bg-card px-3 py-2.5 text-base outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
                />
              </label>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p
                  id="voice-vocabulary-help"
                  className={cn(
                    'text-base tabular-nums sm:text-sm',
                    parsedVocabulary.error ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {parsedVocabulary.error ??
                    `${parsedVocabulary.terms.length} of ${MAX_VOCABULARY_TERMS} terms. Each term can have up to ${MAX_VOCABULARY_TERM_LENGTH} characters.`}
                </p>
                <Button
                  type="button"
                  className="shrink-0 self-start sm:self-auto"
                  disabled={savingVocabulary || Boolean(parsedVocabulary.error) || !vocabularyChanged}
                  onClick={() => void saveVocabulary()}
                >
                  {savingVocabulary ? 'Saving…' : 'Save vocabulary'}
                </Button>
              </div>
              {status ? (
                <p className="text-base text-muted-foreground sm:text-sm" role="status">
                  {status}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      {onNavigate ? (
        <SettingsRows>
          <SettingsRow
            label="Soniox credentials"
            description="The Soniox key is managed in the secure credentials area."
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => onNavigate('#/settings/credentials?tab=keys&filter=voice')}
              >
                Manage keys
              </Button>
            }
          />
        </SettingsRows>
      ) : null}
    </div>
  );
}
