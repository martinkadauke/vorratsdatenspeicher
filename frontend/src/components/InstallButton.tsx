import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X, Github } from 'lucide-react';
import { api } from '../api/client';
import { FeedbackIconButton } from './ui';

const COMPOSE = `services:
  vds:
    image: ghcr.io/martinkadauke/vorratsdatenspeicher:stable
    ports: ["8766:80"]
    environment:
      DATABASE_URL: postgres://vds:vds@db:5432/vds
      JWT_SECRET: REPLACE_ME           # openssl rand -hex 32
      INTERNAL_SECRET: REPLACE_ME      # openssl rand -hex 32 (anderer Wert)
    volumes: [vds-belege:/receipts]
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped
  db:
    image: postgres:16
    environment: { POSTGRES_USER: vds, POSTGRES_PASSWORD: vds, POSTGRES_DB: vds }
    volumes: [vds-daten:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vds -d vds"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
  searxng:                              # Websuche für die KI — in VDS-Setup als http://searxng:8080 eintragen
    image: searxng/searxng:latest
    configs: [{ source: searxng, target: /etc/searxng/settings.yml }]
    restart: unless-stopped
configs:
  searxng:
    content: |
      use_default_settings: true
      server: { secret_key: "aendern-searxng-secret", limiter: false }
      search: { formats: [html, json] }
volumes: { vds-belege: {}, vds-daten: {} }`;

const REPO = 'https://github.com/martinkadauke/vorratsdatenspeicher';

/** Demo-only: a "get your own copy" CTA floating just above the feedback button, opening
 *  a concise self-host guide (Docker compose + PWA install). */
export function InstallButton() {
  const { i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /** Tell the operator someone is interested. Fire-and-forget and fully ignored on failure: this
   *  is a signal, not a feature, and it must never delay or block the button it hangs off. The
   *  backend counts one per household per day and mails a COUNT — nothing identifying is sent. */
  const ping = (target: 'install' | 'github') => {
    void api('/api/demo/cta', { method: 'POST', body: { target } }).catch(() => { /* never surface */ });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(COMPOSE); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  return (
    <>
      <button
        onClick={() => { ping('install'); setOpen(true); }}
        title={de ? 'Vorratsdatenspeicher selbst hosten' : 'Self-host Vorratsdatenspeicher'}
        className="fixed bottom-32 left-3 z-40 flex items-center gap-1.5 rounded-full border border-emerald-500 bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-lg backdrop-blur transition-colors hover:bg-emerald-700 md:bottom-16"
      >
        <Download size={15} /> {de ? 'Jetzt holen' : 'Get it now'}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setOpen(false)}>
          <div className="max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold">
                <img src="/icon-192.png" alt="" className="h-5 w-5 shrink-0 rounded" />
                {de ? 'Vorratsdatenspeicher selbst hosten' : 'Self-host Vorratsdatenspeicher'}
              </h2>
              <div className="flex items-center gap-0.5">
                {/* This guide's own z-50 backdrop covers the pill below it. */}
                <FeedbackIconButton />
                <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
              </div>
            </div>

            <p className="mb-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {de
                ? 'Diese Demo wird jede Nacht gelöscht. Deine eigene Instanz läuft für immer — ein Docker-Container auf deinem Server, NAS oder Raspberry Pi. Deine Daten bleiben deine.'
                : 'This demo is wiped every night. Your own instance runs forever — one Docker container on your server, NAS or Raspberry Pi. Your data stays yours.'}
            </p>

            <ol className="mb-4 flex flex-col gap-3 text-sm">
              <li className="flex gap-2"><span className="font-bold text-emerald-600">1.</span><span>{de ? 'Docker installieren (Docker Desktop auf Windows/Mac, Docker Engine auf Linux/NAS).' : 'Install Docker (Docker Desktop on Windows/Mac, Docker Engine on Linux/NAS).'}</span></li>
              <li className="flex flex-col gap-1.5">
                <div className="flex gap-2"><span className="font-bold text-emerald-600">2.</span><span>{de ? 'docker-compose.yml speichern (Secrets ändern!) und im selben Ordner starten:' : 'Save docker-compose.yml (change the secrets!), then in that folder run:'}</span></div>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-[11px] leading-relaxed text-zinc-100">{COMPOSE}</pre>
                  <button onClick={copy} className="absolute right-2 top-2 rounded-md bg-zinc-700/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-600">
                    {copied ? (de ? '✓ Kopiert' : '✓ Copied') : (de ? 'Kopieren' : 'Copy')}
                  </button>
                </div>
                <code className="w-fit rounded bg-zinc-100 px-2 py-1 text-[12px] dark:bg-zinc-800">docker compose up -d</code>
              </li>
              <li className="flex gap-2"><span className="font-bold text-emerald-600">3.</span><span>{de ? 'http://localhost:8766 öffnen — der Einrichtungs-Assistent macht den Rest.' : 'Open http://localhost:8766 — the setup wizard handles the rest.'}</span></li>
              <li className="flex gap-2"><span className="font-bold text-emerald-600">4.</span><span>{de ? 'Als App installieren: iPhone → Safari → Teilen → „Zum Home-Bildschirm". Android → Chrome → „App installieren".' : 'Install as an app: iPhone → Safari → Share → "Add to Home Screen". Android → Chrome → "Install app".'}</span></li>
            </ol>

            <a href={REPO} target="_blank" rel="noreferrer" onClick={() => ping('github')} className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
              <Github size={16} /> {de ? 'Auf GitHub ansehen' : 'View on GitHub'}
            </a>
          </div>
        </div>
      )}
    </>
  );
}
