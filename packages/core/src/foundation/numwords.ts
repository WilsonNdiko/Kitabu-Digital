/**
 * Amounts in words for receipts — Kenyan style:
 * "Kenya Shillings Twelve Thousand Five Hundred Only"
 * "Kenya Shillings Twelve Thousand and Fifty Cents Only"
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigitWords(n: number): string {
  if (n === 0) return '';
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]!} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const units = n % 10;
    parts.push(units === 0 ? TENS[Math.floor(n / 10)]! : `${TENS[Math.floor(n / 10)]!}-${ONES[units]!}`);
  } else if (n > 0) {
    parts.push(ONES[n]!);
  }
  return parts.join(' ');
}

/** Convert a minor-units amount to Kenyan receipt words (RECEIPTS.md §6). */
export function shillingsInWords(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError('Amount must be a non-negative integer of minor units');
  }
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  if (whole === 0 && cents === 0) return 'Kenya Shillings Zero Only';

  const groups: ReadonlyArray<readonly [number, string]> = [
    [10 ** 9, 'Billion'], [10 ** 6, 'Million'], [10 ** 3, 'Thousand'],
  ];
  let rest = whole;
  const parts: string[] = [];
  for (const [value, name] of groups) {
    const g = Math.floor(rest / value);
    if (g > 0) {
      parts.push(threeDigitWords(g), name);
      rest %= value;
    }
  }
  if (rest > 0) parts.push(threeDigitWords(rest));

  let words = `Kenya Shillings ${parts.join(' ')}`;
  if (cents > 0) words += ` and ${threeDigitWords(cents)} Cents`;
  return `${words} Only`;
}
