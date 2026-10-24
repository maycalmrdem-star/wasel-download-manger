const SUPPORTED_LANGUAGES = Object.freeze([
  'ara', 'eng', 'fra', 'spa', 'rus', 'deu', 'ita', 'por', 'zho',
  'jpn', 'kor', 'tur', 'nld', 'pol', 'ukr', 'hin', 'ind'
]);

function isSupportedLanguage(language) {
  return SUPPORTED_LANGUAGES.includes(language);
}

module.exports = { SUPPORTED_LANGUAGES, isSupportedLanguage };
