import { useEffect, useState, type ReactNode } from 'react';
import {
  addDebtTransfer,
  addExpense,
  addMember,
  addPayment,
  clearTripId,
  deleteDebtTransfer,
  deleteExpense,
  deletePayment,
  getMe,
  getTripIdFromUrl,
  linkWallet,
  putTripIdInUrl,
  setMe,
  subscribeToExpenses,
  subscribeToPayments,
  subscribeToTransfers,
  unlinkWallet,
  type NewExpenseInput,
  type TripBundle,
} from './lib/api';
import { supabaseConfigured } from './lib/supabase';
import { useTripLoader } from './lib/useTripLoader';
import { writeTripCache } from './lib/tripCache';
import { initializePwa } from './lib/pwa';
import { CURRENCIES, type CurrencyCode } from './lib/currencies';
import BalanceTab from './components/BalanceTab';
import ExpenseForm from './components/ExpenseForm';
import ExpenseList from './components/ExpenseList';
import InviteTab from './components/InviteTab';
import SetupHelp from './components/SetupHelp';
import SetupScreen from './components/SetupScreen';
import TabBar, { type Tab } from './components/TabBar';

function Shell({ children }: { children: ReactNode }) {
  return <div className="app-shell mx-auto min-h-dvh max-w-md">{children}</div>;
}

export default function App() {
  const [tripId, setTripId] = useState<string | null>(() => (supabaseConfigured ? getTripIdFromUrl() : null));
  const { bundle, refreshing, error, updatedAt, refresh, invalidate, setBundle } = useTripLoader(tripId);
  const tripLoaded = Boolean(bundle);
  const [tab, setTab] = useState<Tab>('balances');
  const [addingExpense, setAddingExpense] = useState(false);
  const [meId, setMeIdState] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId || !tripLoaded) return;
    setMeIdState(getMe(tripId));
    putTripIdInUrl(tripId);
  }, [tripId, tripLoaded]);

  useEffect(() => {
    if (!tripId || !tripLoaded) return;
    const unsubscribe = [
      subscribeToExpenses(tripId, invalidate),
      subscribeToPayments(tripId, invalidate),
      subscribeToTransfers(tripId, invalidate),
    ];
    return () => {
      unsubscribe.forEach((fn) => fn());
    };
  }, [tripId, tripLoaded, invalidate]);

  function handleCreated(created: TripBundle) {
    putTripIdInUrl(created.trip.id);
    initializePwa();
    writeTripCache(created);
    setTripId(created.trip.id);
    setMeIdState(getMe(created.trip.id));
  }

  async function handleAddExpense(input: NewExpenseInput) {
    if (!tripId) return;
    const expense = await addExpense(tripId, input);
    setBundle((current) =>
      current ? { ...current, expenses: [expense, ...current.expenses] } : current,
    );
    setTab('expenses');
    setAddingExpense(false);
  }

  async function handleDeleteExpense(expenseId: string) {
    await deleteExpense(expenseId);
    setBundle((current) =>
      current
        ? { ...current, expenses: current.expenses.filter((e) => e.id !== expenseId) }
        : current,
    );
  }

  async function handleAddMember(name: string) {
    if (!tripId || !bundle) throw new Error('Trip is not loaded');
    const member = await addMember(tripId, name);
    setBundle((current) =>
      current ? { ...current, members: [...current.members, member] } : current,
    );
    return member;
  }

  async function handleLinkWallet(memberIds: string[]) {
    if (!bundle) return;
    const updated = await linkWallet(memberIds);
    setBundle((current) =>
      current
        ? {
            ...current,
            members: current.members.map((m) => updated.find((u) => u.id === m.id) ?? m),
          }
        : current,
    );
  }

  async function handleUnlinkWallet(unit: string) {
    const updated = await unlinkWallet(unit);
    setBundle((current) =>
      current
        ? {
            ...current,
            members: current.members.map((m) => updated.find((u) => u.id === m.id) ?? m),
          }
        : current,
    );
  }

  async function handleMarkSettled(
    payerId: string,
    receiverId: string,
    amountMinor: number,
    currency: CurrencyCode,
    paid?: { amountMinor: number; currency: CurrencyCode },
  ) {
    if (!tripId) return;
    const payment = await addPayment(tripId, payerId, receiverId, amountMinor, currency, paid);
    setBundle((current) =>
      current ? { ...current, payments: [payment, ...current.payments] } : current,
    );
  }

  async function handleUndoPayment(paymentId: string) {
    await deletePayment(paymentId);
    setBundle((current) =>
      current
        ? { ...current, payments: current.payments.filter((p) => p.id !== paymentId) }
        : current,
    );
  }

  async function handleAddTransfer(
    payerId: string,
    receiverId: string,
    sourceCurrency: CurrencyCode,
    sourceAmountMinor: number,
    targetCurrency: CurrencyCode,
    targetAmountMinor: number,
  ) {
    if (!tripId) return;
    const transfer = await addDebtTransfer(
      tripId,
      payerId,
      receiverId,
      sourceCurrency,
      sourceAmountMinor,
      targetCurrency,
      targetAmountMinor,
    );
    setBundle((current) =>
      current ? { ...current, transfers: [transfer, ...current.transfers] } : current,
    );
  }

  async function handleUndoTransfer(transferId: string) {
    await deleteDebtTransfer(transferId);
    setBundle((current) =>
      current ? { ...current, transfers: current.transfers.filter((t) => t.id !== transferId) } : current,
    );
  }

  function handleSetMe(memberId: string | null) {
    if (!tripId) return;
    setMe(tripId, memberId);
    setMeIdState(memberId);
  }

  if (!supabaseConfigured) {
    return (
      <Shell>
        <SetupHelp />
      </Shell>
    );
  }

  if (tripId && !bundle && !error) {
    return (
      <Shell>
        <p className="mt-24 text-center text-sm text-slate-400">Загружаем поездку…</p>
      </Shell>
    );
  }

  if (error && !bundle) {
    return (
      <Shell>
        <div className="mt-24 rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-red-600">{error}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
            >
              Повторить
            </button>
            <button
              type="button"
              onClick={() => {
                clearTripId();
                initializePwa();
                setTripId(null);
              }}
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Начать новую поездку
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (!tripId || !bundle) {
    return (
      <Shell>
        <SetupScreen onCreated={handleCreated} />
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="truncate text-xl font-bold text-slate-900">{bundle.trip.name}</h1>
        <span className="shrink-0 rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-semibold text-teal-700">
          {CURRENCIES[bundle.trip.baseCurrency].symbol} {bundle.trip.baseCurrency}
        </span>
      </header>

      {(refreshing || error) && (
        <div role="status" className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
          {error ? (
            <>
              <p>{error}</p>
              <p className="mt-1">Показаны сохранённые данные{updatedAt !== null && ` от ${new Date(updatedAt).toLocaleString('ru-RU')}`}.</p>
              <button type="button" onClick={() => void refresh()} className="mt-2 font-semibold text-teal-700">
                Повторить обновление
              </button>
            </>
          ) : 'Показаны сохранённые данные. Обновляем…'}
        </div>
      )}

      <main>
        {tab === 'balances' && (
          <BalanceTab
            members={bundle.members}
            expenses={bundle.expenses}
            payments={bundle.payments}
            transfers={bundle.transfers}
            baseCurrency={bundle.trip.baseCurrency}
            meId={meId}
            onMarkSettled={handleMarkSettled}
            onUndoPayment={handleUndoPayment}
            onAddTransfer={handleAddTransfer}
            onUndoTransfer={handleUndoTransfer}
          />
        )}
        {tab === 'expenses' &&
          (addingExpense ? (
            <ExpenseForm
              members={bundle.members}
              baseCurrency={bundle.trip.baseCurrency}
              defaultPayerId={meId ?? bundle.members[0]?.id ?? ''}
              onSubmit={handleAddExpense}
              onCancel={() => setAddingExpense(false)}
            />
          ) : (
            <ExpenseList
              expenses={bundle.expenses}
              members={bundle.members}
              baseCurrency={bundle.trip.baseCurrency}
              meId={meId}
              onAdd={() => setAddingExpense(true)}
              onDelete={handleDeleteExpense}
            />
          ))}
        {tab === 'invite' && (
          <InviteTab
            tripId={bundle.trip.id}
            members={bundle.members}
            meId={meId}
            onSetMe={handleSetMe}
            onAddMember={handleAddMember}
            onLinkWallet={handleLinkWallet}
            onUnlinkWallet={handleUnlinkWallet}
          />
        )}
      </main>

      <TabBar
        active={tab}
        onChange={(next) => {
          setTab(next);
          if (next !== 'expenses') setAddingExpense(false);
        }}
      />
    </Shell>
  );
}

