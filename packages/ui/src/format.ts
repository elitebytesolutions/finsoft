export const money = (n: number) => `Rs ${n.toLocaleString('en-PK')}`

export const movementTone = (t: string): 'good' | 'info' | 'warn' | 'danger' | 'neutral' =>
  (
    ({
      Purchase: 'good',
      'Stock In': 'good',
      Sale: 'info',
      Gift: 'info',
      Count: 'info',
      Breakage: 'danger',
      Issue: 'danger',
      Transfer: 'warn',
      Adjustment: 'warn',
    }) as Record<string, 'good' | 'info' | 'warn' | 'danger' | 'neutral'>
  )[t] ?? 'neutral'
