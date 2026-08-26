import { db } from './db';
import { UserBalanceSummary, User } from './types';

export function calculateUserBalance(userId: string): UserBalanceSummary {
  const user = db.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date();
  const settings = db.getSettings();
  const deposits = db.getDeposits(userId);
  const earnings = db.getEarnings(userId);
  const withdrawals = db.getWithdrawals(userId);

  // 1. Confirmed deposits
  const confirmedDeposits = deposits.filter(d => d.status === 'confirmed');
  const totalDeposited = confirmedDeposits.reduce((acc, d) => acc + d.amount, 0);

  // 2. Total earnings
  const creditedEarnings = earnings.filter(e => e.status === 'credited');
  const totalEarnings = creditedEarnings.reduce((acc, e) => acc + e.earningsAmount, 0);

  // 3. Withdrawals
  const paidWithdrawals = withdrawals.filter(w => w.status === 'paid');
  const totalWithdrawn = paidWithdrawals.reduce((acc, w) => acc + w.requestedAmount, 0);
  const totalFeesPaid = paidWithdrawals.reduce((acc, w) => acc + w.feeAmount, 0);

  // Active pending/processing withdrawals that hold balance
  const activePendingWithdrawals = withdrawals.filter(
    w => w.status === 'pending' || w.status === 'under_review' || w.status === 'approved' || w.status === 'processing'
  );
  const totalPendingWithdrawals = activePendingWithdrawals.reduce((acc, w) => acc + w.requestedAmount, 0);

  // Total balance = Total Deposited + Total Earnings - Total Withdrawn - Total Pending
  const rawBalance = totalDeposited + totalEarnings - totalWithdrawn - totalPendingWithdrawals;
  const availableBalance = Math.max(0, Number(rawBalance.toFixed(4)));

  // 4. Calculate locked deposit principal (deposits under 20 days)
  const depositLockMs = (settings.depositLockPeriodDays || 20) * 24 * 60 * 60 * 1000;
  let lockedBalance = 0;

  for (const dep of confirmedDeposits) {
    if (dep.confirmedAt) {
      const confirmedDate = new Date(dep.confirmedAt).getTime();
      const lockExpiry = confirmedDate + depositLockMs;
      if (now.getTime() < lockExpiry) {
        lockedBalance += dep.amount;
      }
    }
  }

  // 5. Check 30-day account age rule
  const createdAtTime = new Date(user.createdAt).getTime();
  const accountAgeMs = now.getTime() - createdAtTime;
  const requiredAgeMs = (settings.accountAgeRequirementDays || 30) * 24 * 60 * 60 * 1000;
  const is30DaysOld = accountAgeMs >= requiredAgeMs;
  const accountAgeDays = Number((accountAgeMs / (24 * 60 * 60 * 1000)).toFixed(2));
  const withdrawalEligibleDate = new Date(createdAtTime + requiredAgeMs).toISOString();

  let canWithdraw = true;
  let withdrawalRestrictionReason: string | undefined = undefined;

  if (user.status !== 'active') {
    canWithdraw = false;
    withdrawalRestrictionReason = `Account is currently ${user.status}.`;
  } else if (!is30DaysOld) {
    canWithdraw = false;
    const remainingMs = Math.max(0, requiredAgeMs - accountAgeMs);
    const remDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const remHours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    withdrawalRestrictionReason = `Account must complete 30 full days before withdrawal. Remaining: ${remDays}d ${remHours}h.`;
  } else if (availableBalance <= 0) {
    canWithdraw = false;
    withdrawalRestrictionReason = 'Insufficient available balance.';
  }

  // Eligible amount is available balance minus locked deposits (if account is >= 30 days old)
  let eligibleForWithdrawal = 0;
  if (is30DaysOld && user.status === 'active') {
    // Earnings are always withdrawable once account is 30 days old; deposits locked for 20 days are restricted
    eligibleForWithdrawal = Math.max(0, Number((availableBalance - lockedBalance).toFixed(4)));
  }

  return {
    userId,
    totalDeposited: Number(totalDeposited.toFixed(4)),
    totalEarnings: Number(totalEarnings.toFixed(4)),
    totalWithdrawn: Number(totalWithdrawn.toFixed(4)),
    totalFeesPaid: Number(totalFeesPaid.toFixed(4)),
    totalPendingWithdrawals: Number(totalPendingWithdrawals.toFixed(4)),
    availableBalance,
    lockedBalance: Number(lockedBalance.toFixed(4)),
    eligibleForWithdrawal,
    accountAgeDays,
    is30DaysOld,
    canWithdraw: canWithdraw && eligibleForWithdrawal > 0,
    withdrawalRestrictionReason,
    withdrawalEligibleDate,
  };
}

/**
 * Reconciles the calculated balance with the total ledger entries.
 */
export function reconcileLedger(userId: string): { isReconciled: boolean; ledgerSum: number; calculatedBalance: number } {
  const ledger = db.getLedger(userId);
  const ledgerSum = ledger.reduce((acc, entry) => acc + entry.amount, 0);
  const summary = calculateUserBalance(userId);
  
  // Ledger includes deposited (+), earnings (+), withdrawal_paid (-), fees (-), pending withdrawal deductions (-)
  const isReconciled = Math.abs(ledgerSum - summary.availableBalance) < 0.0001;

  return {
    isReconciled,
    ledgerSum: Number(ledgerSum.toFixed(4)),
    calculatedBalance: summary.availableBalance,
  };
}
