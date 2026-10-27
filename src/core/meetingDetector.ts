import type { MeetingLink, Platform } from './types.js';

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const TEAMS_HOSTS = new Set(['teams.microsoft.com', 'teams.live.com']);

/**
 * Identifica enlaces oficiales de Google Meet y Microsoft Teams.
 * Solo acepta HTTPS y hosts exactos; cualquier otro enlace se descarta.
 */
export function parseMeetingUrl(raw: string): MeetingLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  if (url.hostname === 'meet.google.com') {
    const code = url.pathname.slice(1);
    if (!MEET_CODE.test(code)) return null;
    return build('google_meet', `https://meet.google.com/${code}`, code);
  }

  if (TEAMS_HOSTS.has(url.hostname)) {
    const segments = url.pathname.split('/').filter(Boolean);
    const joinIndex = segments.indexOf('meetup-join');
    if (joinIndex >= 0 && segments[joinIndex + 1]) {
      const threadId = decodeURIComponent(segments[joinIndex + 1]);
      return build('microsoft_teams', url.toString(), threadId);
    }
    if (segments[0] === 'meet' && segments[1]) {
      return build('microsoft_teams', url.toString(), segments[1]);
    }
  }
  return null;
}

/** Extrae todos los enlaces de reunión válidos de un texto libre (ubicación, descripción…). */
export function findMeetingLinks(text: string | null | undefined): MeetingLink[] {
  if (!text) return [];
  const candidates = text.match(/https:\/\/[^\s<>"')]+/g) ?? [];
  const seen = new Map<string, MeetingLink>();
  for (const candidate of candidates) {
    const link = parseMeetingUrl(candidate);
    if (link && !seen.has(link.canonicalId)) seen.set(link.canonicalId, link);
  }
  return [...seen.values()];
}

/** Elige el enlace principal: el primero explícito del proveedor, o el primero encontrado. */
export function pickPrimaryLink(links: MeetingLink[]): MeetingLink | null {
  return links[0] ?? null;
}

/** Clave estable para deduplicar la misma reunión llegada desde varios calendarios. */
export function canonicalPlatformKey(platform: Platform, canonicalId: string): string {
  return `${platform}:${canonicalId}`;
}

function build(platform: Platform, url: string, canonicalId: string): MeetingLink {
  return { platform, url, canonicalId };
}
