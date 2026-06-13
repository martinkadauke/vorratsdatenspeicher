import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ReceiptText, ChartPie, ShoppingCart, Package, Tags, Users, Sparkles, BadgePercent,
  ChevronLeft, ChevronRight, X,
} from 'lucide-react';
import { api } from '../api/client';
import { Button } from './ui';
import { useAuth } from '../context/auth';

interface TourStep {
  icon: typeof ReceiptText;
  titleKey: string;
  bodyKey: string;
  emoji: string;
}

const STEPS: TourStep[] = [
  { icon: Sparkles,     titleKey: 'tour.welcome.title',  bodyKey: 'tour.welcome.body',  emoji: '👋' },
  { icon: ReceiptText,  titleKey: 'tour.receipts.title', bodyKey: 'tour.receipts.body', emoji: '🧾' },
  { icon: Tags,         titleKey: 'tour.names.title',    bodyKey: 'tour.names.body',    emoji: '🏷️' },
  { icon: BadgePercent, titleKey: 'tour.offers.title',   bodyKey: 'tour.offers.body',   emoji: '🛒' },
  { icon: ChartPie,     titleKey: 'tour.stats.title',    bodyKey: 'tour.stats.body',    emoji: '📊' },
  { icon: ShoppingCart, titleKey: 'tour.shopping.title', bodyKey: 'tour.shopping.body', emoji: '🛍️' },
  { icon: Package,      titleKey: 'tour.pantry.title',   bodyKey: 'tour.pantry.body',   emoji: '📦' },
  { icon: Users,        titleKey: 'tour.family.title',   bodyKey: 'tour.family.body',   emoji: '👨‍👩‍👧‍👦' },
  { icon: Sparkles,     titleKey: 'tour.done.title',     bodyKey: 'tour.done.body',     emoji: '🎉' },
];

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { refreshUser } = useAuth();
  const [step, setStep] = useState(0);

  const markSeen = useMutation({
    mutationFn: () => api('/api/me', { method: 'PATCH', body: { has_seen_tour: true } }),
    onSuccess: () => void refreshUser(),
  });

  if (!open) return null;

  const finish = () => {
    markSeen.mutate();
    onClose();
    setStep(0);
  };

  const skip = () => finish();
  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : finish());
  const prev = () => step > 0 && setStep(step - 1);

  const current = STEPS[step];
  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
        <button
          onClick={skip}
          className="absolute right-3 top-3 z-10 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label={t('tour.skip')}
        >
          <X size={18} />
        </button>

        {/* Hero illustration */}
        <div className="flex h-32 items-center justify-center bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900">
          <div className="text-6xl">{current.emoji}</div>
        </div>

        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-500">
            <Icon size={18} />
            <span className="text-xs font-medium uppercase tracking-wide">
              {step + 1} / {STEPS.length}
            </span>
          </div>

          <h2 className="text-xl font-bold">{t(current.titleKey)}</h2>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            {t(current.bodyKey)}
          </p>

          {/* Progress dots */}
          <div className="flex justify-center gap-1.5 pt-2">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-6 bg-emerald-600' : 'w-1.5 bg-zinc-300 dark:bg-zinc-700'
                }`}
                aria-label={`${t('tour.gotoStep')} ${i + 1}`}
              />
            ))}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={prev}
              disabled={step === 0}
              className="px-3"
            >
              <ChevronLeft size={16} /> {t('tour.prev')}
            </Button>
            <Button variant="ghost" onClick={skip} className="text-xs text-zinc-400">
              {t('tour.skip')}
            </Button>
            <Button onClick={next} className="px-4">
              {step === STEPS.length - 1 ? t('tour.finish') : t('tour.next')}
              {step < STEPS.length - 1 && <ChevronRight size={16} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
