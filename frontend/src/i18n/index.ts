import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './de.json';
import en from './en.json';

export const LANG_KEY = 'vds_lang';

void i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en },
  },
  lng: localStorage.getItem(LANG_KEY) ?? 'de',
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: string): void {
  localStorage.setItem(LANG_KEY, lang);
  void i18n.changeLanguage(lang);
}

export default i18n;
