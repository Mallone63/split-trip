export default function SetupHelp() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold text-slate-900">Trip Split</h1>
      <p className="text-sm text-slate-600">
        Приложение ещё не подключено к бэкенду. Нужен бесплатный проект Supabase — в нём
        будут храниться общие расходы.
      </p>
      <ol className="list-decimal space-y-3 rounded-2xl bg-white p-4 pl-8 text-sm text-slate-700 shadow-sm">
        <li>
          Создайте проект на <span className="font-mono">supabase.com</span> (хватит
          бесплатного тарифа).
        </li>
        <li>
          Откройте SQL Editor и выполните{' '}
          <span className="font-mono">supabase/schema.sql</span> из этого проекта.
        </li>
        <li>
          Скопируйте URL проекта и anon key в файл{' '}
          <span className="font-mono">.env</span>:
          <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs">
            {'VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co\nVITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY'}
          </pre>
        </li>
        <li>Перезапустите dev-сервер (или передеплойте) и обновите страницу.</li>
      </ol>
    </div>
  );
}
