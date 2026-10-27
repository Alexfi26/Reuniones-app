import type { MeetingNotes } from '../notes/meetingNotes.js';
import type { Transcript } from '../transcription/transcription.js';
import { formatTimestamp } from '../transcription/transcription.js';
import type { DocBlock, RenderedDocument } from './googleDocs.js';

export interface DocumentContext {
  title: string;
  dateLocal: string;
  startLocal: string;
  endLocal: string | null;
  platformLabel: string;
  organizer: string | null;
}

const NOT_DEFINED = 'No definido';

/** Convierte las notas validadas en el documento de las secciones A–H del formato acordado. */
export function buildMeetingDocument(
  context: DocumentContext,
  notes: MeetingNotes,
  transcript: Transcript | null,
  includeTranscript: boolean,
): RenderedDocument {
  const blocks: DocBlock[] = [{ kind: 'title', text: context.title }];

  blocks.push({ kind: 'heading1', text: 'Información general' });
  bullet(blocks, `Fecha: ${context.dateLocal}`);
  bullet(blocks, `Hora de inicio: ${context.startLocal}`);
  bullet(blocks, `Hora de finalización: ${context.endLocal ?? 'No disponible'}`);
  bullet(blocks, `Plataforma: ${context.platformLabel}`);
  bullet(blocks, `Organizador: ${context.organizer ?? 'No disponible'}`);
  bullet(blocks, `Participantes identificados: ${notes.general.participants.join(', ') || 'No identificados con certeza'}`);
  bullet(blocks, `Objetivo: ${notes.general.objective ?? 'No identificado en la conversación'}`);

  blocks.push({ kind: 'heading1', text: 'Resumen ejecutivo' }, { kind: 'paragraph', text: notes.executiveSummary });

  blocks.push({ kind: 'heading1', text: 'Temas tratados' });
  if (notes.topics.length === 0) blocks.push({ kind: 'paragraph', text: 'No se identificaron temas.' });
  for (const topic of notes.topics) {
    blocks.push({ kind: 'heading2', text: topic.title });
    for (const point of topic.points) bullet(blocks, point);
  }

  blocks.push({ kind: 'heading1', text: 'Decisiones y acuerdos' });
  if (notes.decisions.length === 0) blocks.push({ kind: 'paragraph', text: 'No se registraron decisiones explícitas.' });
  for (const decision of notes.decisions) bullet(blocks, decision.text);

  blocks.push({ kind: 'heading1', text: 'Tareas y próximos pasos' });
  const table = {
    headers: ['Tarea', 'Responsable', 'Fecha límite', 'Estado'],
    rows: notes.tasks.map((t) => [t.task, t.owner ?? NOT_DEFINED, t.dueDate ?? NOT_DEFINED, t.status]),
  };
  if (notes.tasks.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No se identificaron tareas.' });
  } else {
    blocks.push({ kind: 'table' });
  }

  blocks.push({ kind: 'heading1', text: 'Pendientes y preguntas abiertas' });
  if (notes.openQuestions.length === 0) blocks.push({ kind: 'paragraph', text: 'Ninguna identificada.' });
  for (const question of notes.openQuestions) bullet(blocks, question);

  blocks.push({ kind: 'heading1', text: 'Riesgos y oportunidades' });
  if (notes.risksAndOpportunities.length === 0) blocks.push({ kind: 'paragraph', text: 'Ninguno mencionado explícitamente.' });
  for (const item of notes.risksAndOpportunities) bullet(blocks, `[${item.type}] ${item.text}`);

  if (notes.transcriptionIssues.length > 0) {
    blocks.push({ kind: 'heading1', text: 'Posibles errores de transcripción' });
    for (const issue of notes.transcriptionIssues) bullet(blocks, issue);
  }

  if (includeTranscript && transcript) {
    blocks.push({ kind: 'heading1', text: 'Transcripción' });
    if (transcript.segments.length === 0) blocks.push({ kind: 'paragraph', text: 'No se detectó voz en el audio.' });
    for (const segment of transcript.segments) {
      const speaker = segment.speaker ? `${segment.speaker}: ` : '';
      blocks.push({ kind: 'paragraph', text: `[${formatTimestamp(segment.startMs)}] ${speaker}${segment.text}` });
    }
  }

  return { blocks, table };
}

/** Nombre del documento con el formato AAAA-MM-DD - Nombre de la reunión - Notas. */
export function documentName(dateLocal: string, title: string): string {
  const safeTitle = title.replace(/[\u0000-\u001f]/g, ' ').trim() || 'Reunión';
  return `${dateLocal} - ${safeTitle} - Notas`;
}

function bullet(blocks: DocBlock[], text: string): void {
  blocks.push({ kind: 'bullet', text });
}
