import type { OpportunityListItem, PipelineItem, PipelineStageItem } from '@ooh/contracts';

/** Active OPEN stages in board order (WON/LOST are outcomes, not columns). */
export function openStages(pipeline: PipelineItem | undefined): PipelineStageItem[] {
  return (pipeline?.stages ?? [])
    .filter((s) => s.kind === 'OPEN' && s.active)
    .sort((a, b) => a.position - b.position);
}

/** Opportunities per stage id, keeping the list order (every stage gets a column, even empty). */
export function groupByStage(
  stages: readonly PipelineStageItem[],
  opportunities: readonly OpportunityListItem[],
): Map<string, OpportunityListItem[]> {
  const columns = new Map(stages.map((s) => [s.id, [] as OpportunityListItem[]]));
  for (const o of opportunities) columns.get(o.stage.id)?.push(o);
  return columns;
}

/** What still has to be supplied to win (the database refuses WON without both). */
export function missingToWin(o: Pick<OpportunityListItem, 'estimatedValue' | 'expectedCloseDate'>) {
  return { value: o.estimatedValue === null, closeDate: o.expectedCloseDate === null };
}

/** Totals per currency (RON and EUR are never added together). */
export function totalsByCurrency(opportunities: readonly OpportunityListItem[]): string {
  const sums = new Map<string, number>();
  for (const o of opportunities) {
    if (o.estimatedValue !== null)
      sums.set(o.currency, (sums.get(o.currency) ?? 0) + Number(o.estimatedValue));
  }
  return [...sums].map(([currency, sum]) => formatMoney(sum.toFixed(2), currency)).join(' + ');
}

export function formatMoney(value: string | null, currency: string): string {
  if (value === null) return '';
  return `${Number(value).toLocaleString('ro-RO', { maximumFractionDigits: 2 })} ${currency}`;
}
