// Panel language. Everything the player reads in the overlay goes through t();
// static markup is tagged data-i18n / data-i18n-title and filled by
// applyTranslations(). The services keep producing their status lines in
// English (they are logged too, and tests pin them); translateStatus() maps
// those to the panel language at display time.

import { WARN_NOT_FOUND, WARN_IMPLAUSIBLE, WARN_QUERY_FAILED } from '../core/game-window';

export type Lang = 'en' | 'es';
export const LANGUAGES: ReadonlyArray<{ code: Lang; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
];

const LANG_KEY = 'lolproxchat.language';

// Duplicated from tracking.ts rather than imported: tracking.ts pulls in the
// whole CV pipeline, and the overlay only needs the two strings.
const WARN_MINIMAP_TOO_LARGE = "Minimap too large to capture — lower MinimapScale in League's HUD.";
const WARN_CALIBRATION_OUTSIDE_CAPTURE = 'Calibrated minimap is outside the capture area — recalibrate.';

const STRINGS = {
  'header.selfMute': { en: 'Toggle Self Mute', es: 'Silenciar/activar tu micrófono' },
  'header.muteAll': { en: 'Mute All', es: 'Silenciar a todos' },
  'header.pos': {
    en: "Wrong position? If people next to you can't hear you, click this, then walk somewhere: the app finds your champion on the minimap again. Until it does, only your team hears you.",
    es: '¿Posición incorrecta? Si los jugadores que tienes al lado no te oyen, haz clic aquí y luego muévete un poco: la app volverá a encontrar a tu campeón en el minimapa. Hasta entonces, solo te oye tu equipo.',
  },
  'header.posLabel': { en: 'POS', es: 'POS' },
  'header.settings': { en: 'Settings', es: 'Ajustes' },
  'header.settingsLabel': { en: 'SET', es: 'CFG' },
  'header.collapse': { en: 'Collapse', es: 'Contraer' },
  'header.expand': { en: 'Expand', es: 'Expandir' },

  'players.waiting': { en: 'Waiting for nearby players...', es: 'Esperando jugadores cercanos...' },
  'players.dead': { en: 'DEAD', es: 'MUERTO' },
  // The row's indicator: the player muted their own mic.
  'players.muted': { en: 'MUTED', es: 'SIN MIC' },
  // The row's button, and its state once you have muted them.
  'players.mutedByYou': { en: 'MUTED', es: 'MUTEADO' },
  'players.mute': { en: 'MUTE', es: 'MUTEAR' },

  'settings.language': { en: 'Language', es: 'Idioma' },
  'settings.inputDevice': { en: 'Input Device', es: 'Entrada de audio' },
  'settings.outputDevice': { en: 'Output Device', es: 'Salida de audio' },
  'settings.default': { en: 'Default', es: 'Predeterminado' },
  'settings.unnamedInput': { en: '(unnamed audioinput)', es: '(dispositivo sin nombre)' },
  'settings.unnamedOutput': { en: '(unnamed audiooutput)', es: '(dispositivo sin nombre)' },
  'settings.inputMode': { en: 'Input Mode', es: 'Modo de entrada' },
  'settings.alwaysOpen': { en: 'Always Open', es: 'Siempre abierto' },
  'settings.pushToTalk': { en: 'Push to Talk', es: 'Pulsar para hablar' },
  'settings.pttKey': { en: 'PTT Key', es: 'Tecla PTT' },
  'settings.pttKeyHint': {
    en: "Push-to-talk key. Default Caps Lock. The LED won't toggle (Discord-style synthetic flip-back).",
    es: 'Tecla para hablar (PTT). Por defecto, Bloq Mayús. Su luz no se encenderá (se revierte al instante, como hace Discord).',
  },
  'settings.toggleKey': { en: 'Toggle-mute Key', es: 'Tecla de silencio' },
  'settings.toggleKeyHint': {
    en: 'Optional toggle-self-mute hotkey. Click to bind a key; click again to clear.',
    es: 'Atajo opcional para silenciar o activar tu micrófono. Haz clic para asignar una tecla; vuelve a hacer clic para quitarla.',
  },
  'settings.unbound': { en: '(unbound)', es: '(sin asignar)' },
  'settings.pressKey': { en: 'Press a key…', es: 'Presiona una tecla…' },
  'settings.forbiddenKey': { en: '(LoL/system key — pick another)', es: '(tecla reservada)' },
  'settings.unsupportedKey': { en: '(key not supported)', es: '(tecla no compatible)' },
  'settings.micVolume': { en: 'Mic Volume', es: 'Volumen mic' },
  'settings.forceTurn': { en: 'Hide IP (Force TURN)', es: 'Ocultar IP (forzar TURN)' },
  'settings.forceTurnHint': {
    en: 'Routes all voice through the TURN relay so peers never see your public IP. Adds ~20-100ms latency. Takes effect on next peer connection.',
    es: 'Envía la voz a través del servidor de retransmisión TURN, para que los demás jugadores nunca vean tu IP pública. Añade unos 20-100 ms de latencia. Se aplica a partir de la próxima conexión con otro jugador.',
  },
  'settings.allyProximity': { en: 'Ally proximity', es: 'Proximidad aliada' },
  'settings.allyProximityHint': {
    en: 'When ON, teammates fade with distance just like enemies. When OFF (default), teammates are always at full volume. Takes effect on the next position update.',
    es: 'Si está activado, el volumen de tus compañeros baja con la distancia, igual que el de los enemigos. Si está desactivado (por defecto), siempre oyes a tus compañeros a todo volumen. Se aplica en la siguiente actualización de posición.',
  },
  'settings.cameraListen': { en: 'Voice on camera', es: 'Oír desde la cámara' },
  'settings.cameraListenHint': {
    en: "When ON, you also hear the map from wherever your camera is looking, not just from your champion. One-way: the people you listen in on only hear you if they are near your champion or looking at you themselves. Only works between players who BOTH have it on: leave it off and nobody's camera can reach you, only players actually near you on the map. Off by default, because it lets you hear enemies your champion could not see.",
    es: 'Si está activado, también oyes el mapa desde donde esté mirando tu cámara, no solo desde tu campeón. Funciona en un solo sentido: los jugadores a los que escuchas así solo te oyen si están cerca de tu campeón o si ellos mismos te están mirando. Solo funciona si ambos jugadores lo tienen activado: si lo dejas desactivado, la cámara de nadie te alcanza y solo te oyen los jugadores que de verdad están cerca de ti en el mapa. Viene desactivado porque te permite oír a enemigos que tu campeón no podría ver.',
  },
  'settings.wrongPosition': { en: 'Wrong position?', es: '¿Posición incorrecta?' },
  'settings.wrongPositionHint': {
    en: "If people near you can't hear you, the app may be tracking the wrong icon on your minimap (it can latch onto a ward you walked past). This drops the current position and finds your champion again; walk somewhere after pressing it so it can tell you apart. Until it finds you, only your team hears you.",
    es: 'Si los jugadores cercanos no te oyen, puede que la app esté siguiendo el icono equivocado en tu minimapa (puede quedarse pegada a un ward junto al que pasaste). Esto descarta la posición actual y vuelve a buscar a tu campeón; muévete después de presionarlo para que pueda distinguirte. Hasta que te encuentre, solo te oye tu equipo.',
  },
  'settings.reset': { en: 'RESET', es: 'REINICIAR' },
  'settings.searching': { en: 'SEARCHING', es: 'BUSCANDO' },
  'settings.debug': { en: 'Debug', es: 'Depuración' },
  'settings.debugLogs': { en: 'Debug Logs', es: 'Registros' },
  'settings.openLogsHint': {
    en: 'Open log folder to attach to a GitHub issue',
    es: 'Abre la carpeta de registros para adjuntarlos a un reporte en GitHub',
  },
  'settings.open': { en: 'OPEN', es: 'ABRIR' },
  'settings.autoUpdate': { en: 'Auto-update', es: 'Autoactualizar' },
  'settings.updates': { en: 'Updates', es: 'Actualizaciones' },
  'settings.check': { en: 'CHECK', es: 'BUSCAR' },
  'settings.scanRate': { en: 'Scan Rate', es: 'Tasa de escaneo' },
  'settings.on': { en: 'ON', es: 'SÍ' },
  'settings.off': { en: 'OFF', es: 'NO' },

  'update.checking': { en: 'Checking for updates…', es: 'Buscando actualizaciones…' },
  'update.available': { en: 'Update available: v{version} — applying…', es: 'Actualización disponible: v{version} — instalando…' },
  'update.upToDate': { en: 'Up to date (v{version})', es: 'Ya tienes la última versión (v{version})' },
  'update.failed': { en: 'Update check failed: {error}', es: 'Error al buscar actualizaciones: {error}' },
} as const;

export type StringKey = keyof typeof STRINGS;

// The orchestrator's and the game-window / tracking warnings' exact wording.
const STATUS_ES: Record<string, string> = {
  'Waiting for League of Legends': 'Esperando a League of Legends',
  'Searching for your champion on the minimap': 'Buscando a tu campeón en el minimapa',
  'In client': 'En el cliente',
  'In lobby': 'En la sala',
  'Searching for match': 'Buscando partida',
  'Ready check': 'Partida encontrada',
  'In champion select': 'En selección de campeón',
  'Joining game...': 'Uniéndote a la partida...',
  'Game complete': 'Partida terminada',
  'End of game': 'Fin de la partida',
  // League client phases the orchestrator passes through as-is.
  'Reconnect': 'Reconectando',
  'CheckedIntoTournament': 'Inscrito en un torneo',
  'TerminatedInError': 'La partida terminó con un error',
  "Couldn't read your Riot ID from League — see log": 'No se pudo leer tu Riot ID desde League — revisa el registro',
  "Couldn't match your Riot ID to the player list — see log": 'No se encontró tu Riot ID en la lista de jugadores — revisa el registro',
  'Streamer mode detected — not joining proximity chat': 'Modo streamer detectado — no te unirás al chat de proximidad',
  [WARN_NOT_FOUND]: 'No se encuentra la ventana de League — usa el modo Sin bordes, no Pantalla completa.',
  [WARN_IMPLAUSIBLE]: 'La ventana de League parece incorrecta — usando el monitor principal.',
  [WARN_QUERY_FAILED]: 'No se pudo leer la ventana de League — usando el monitor principal.',
  [WARN_MINIMAP_TOO_LARGE]: 'El minimapa es demasiado grande para capturarlo — baja la escala del minimapa en la interfaz de League.',
  [WARN_CALIBRATION_OUTSIDE_CAPTURE]: 'El minimapa calibrado está fuera del área de captura — vuelve a calibrarlo.',
};

const KEYS_ES: Record<string, string> = {
  'Caps Lock': 'Bloq Mayús',
  'Delete': 'Supr',
  'Home': 'Inicio',
  'End': 'Fin',
  'Page Up': 'Re Pág',
  'Page Down': 'Av Pág',
  'Space': 'Espacio',
  'Unknown': 'Desconocida',
};

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

// Read once: t() runs several times per player row at the position-tick rate.
let current: Lang | null = null;

/** The stored choice, else Spanish for a Spanish-language system, else English. */
export function getLanguage(): Lang {
  if (current) return current;
  let stored: string | null = null;
  try { stored = storage()?.getItem(LANG_KEY) ?? null; } catch { /* treat as unset */ }
  if (stored === 'en' || stored === 'es') return (current = stored);
  const sys = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return (current = sys.toLowerCase().startsWith('es') ? 'es' : 'en');
}

export function setLanguage(lang: Lang): void {
  current = lang;
  try { storage()?.setItem(LANG_KEY, lang); } catch { /* not persisted; still applies this session */ }
}

export function t(key: StringKey, params: Record<string, string> = {}, lang: Lang = getLanguage()): string {
  let s: string = STRINGS[key][lang];
  for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(v);
  return s;
}

/** A status line from the services, in the panel language. */
export function translateStatus(english: string, lang: Lang = getLanguage()): string {
  if (lang === 'en' || !english) return english;
  const exact = STATUS_ES[english];
  if (exact) return exact;
  const map = /^Proximity is off — (.+) is not a supported map$/.exec(english);
  if (map) return 'Proximidad desactivada — ' + map[1] + ' no es un mapa compatible';
  return english;
}

/** A key name from humanizeVk, in the panel language. */
export function translateKey(label: string, lang: Lang = getLanguage()): string {
  return lang === 'es' ? KEYS_ES[label] ?? label : label;
}

export function allKeys(): StringKey[] {
  return Object.keys(STRINGS) as StringKey[];
}

/** Fill every data-i18n (text) and data-i18n-title (tooltip) element. */
export function applyTranslations(root: ParentNode, lang: Lang = getLanguage()): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    el.textContent = t(el.dataset.i18n as StringKey, {}, lang);
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-title]'))) {
    el.title = t(el.dataset.i18nTitle as StringKey, {}, lang);
  }
}
