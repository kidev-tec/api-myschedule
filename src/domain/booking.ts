/**
 * Regra central de agendamento: dois intervalos [start, end) conflitam
 * se há interseção. Encostado no fim/início NÃO conflita (end exclusivo).
 *
 * A duplicação no banco é garantida por exclusion constraint (gist +
 * tstzrange) — ver src/db/schema.ts. Esta função é a validação de
 * aplicação que dá erro amigável ANTES de chegar ao banco, e a fonte
 * de verdade testada com coverage 100%.
 */
export function overlaps(
  existingStart: Date,
  existingEnd: Date,
  newStart: Date,
  newEnd: Date,
): boolean {
  if (
    existingStart >= existingEnd ||
    newStart >= newEnd
  ) {
    throw new Error("booking invariant violation: start must be < end");
  }
  // [a1,a2) e [b1,b2) intersectam sse a1 < b2 && b1 < a2
  return existingStart < newEnd && newStart < existingEnd;
}
