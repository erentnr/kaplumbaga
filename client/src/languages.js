// race text languages, the texts themselves live on the server
export const LANGUAGES = [
  { code: 'tr', name: 'Türkçe' },
  { code: 'en', name: 'English' },
  { code: 'pt', name: 'Português' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
];

const isSupported = (code) => LANGUAGES.some(language => language.code === code)

// language for rooms this player creates: last picked one, else the browser's
export const getPreferredLanguage = () => {
  const saved = localStorage.getItem("language")
  if (isSupported(saved)) return saved
  for (const tag of navigator.languages || []) {
    const code = tag.slice(0, 2).toLowerCase()
    if (isSupported(code)) return code
  }
  return 'en'
}

export const savePreferredLanguage = (code) => {
  localStorage.setItem("language", code)
}
