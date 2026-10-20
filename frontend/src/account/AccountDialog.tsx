import { useEffect, useId, useState, type FormEvent } from "react";
import Modal from "../components/Modal";
import { accountRu } from "../i18n/ru";
import type { Filters, POI } from "../types";
import { useAccount } from "./AccountProvider";
import type { SavedWalk, WalkPreferences } from "./types";

type AccountDialogProps = {
  onOpenPoi: (id: string) => void;
  onRoutePoi?: (id: string) => void;
  onOpenWalk: (walk: SavedWalk) => void;
  resolvePoiName?: (id: string) => string | undefined;
  currentPreferences?: Filters;
  onApplyPreferences?: (preferences: WalkPreferences) => void;
};

function AuthForm() {
  const account = useAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  const creatingPassword =
    account.mode === "signup" || account.mode === "reset";
  const reset = account.mode === "reset";
  const recovery = account.mode === "recover";
  const submitLabel = reset
    ? accountRu.reset
    : recovery
      ? accountRu.sendRecovery
      : account.mode === "signup"
        ? accountRu.signUp
        : accountRu.signIn;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (account.busy) return;
    setValidation("");
    if (creatingPassword && password !== confirmation) {
      setValidation(accountRu.mismatch);
      return;
    }
    const success = reset
      ? await account.resetPassword(password)
      : recovery
        ? await account.recover(email)
        : account.mode === "signup"
          ? await account.signUp(email, password)
          : await account.signIn(email, password);
    if (success) {
      setPassword("");
      setConfirmation("");
    }
  };
  return (
    <>
      <p className="account-muted">{accountRu.guest}</p>
      <form className="account-form" onSubmit={(event) => void submit(event)}>
        {!reset && (
          <label htmlFor="account-email">
            {accountRu.email}
            <input
              id="account-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={account.busy}
            />
          </label>
        )}
        {!recovery && (
          <label htmlFor="account-password">
            {reset ? accountRu.newPassword : accountRu.password}
            <input
              id="account-password"
              type="password"
              autoComplete={
                creatingPassword ? "new-password" : "current-password"
              }
              required
              minLength={creatingPassword ? 8 : 1}
              maxLength={128}
              aria-describedby={
                creatingPassword ? "account-password-hint" : undefined
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={account.busy}
            />
          </label>
        )}
        {creatingPassword && (
          <>
            <p id="account-password-hint" className="account-muted">
              {accountRu.passwordHint}
            </p>
            <label htmlFor="account-confirmation">
              {accountRu.confirmPassword}
              <input
                id="account-confirmation"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={account.busy}
              />
            </label>
          </>
        )}
        {validation && (
          <p role="alert" className="account-error">
            {validation}
          </p>
        )}
        <button
          className="primary-button"
          type="submit"
          disabled={account.busy || account.loading || !account.configured}
        >
          {account.busy ? accountRu.submitting : submitLabel}
        </button>
      </form>
      {!reset && (
        <div className="account-actions">
          {account.mode !== "signin" && (
            <button
              type="button"
              className="text-button"
              onClick={() => account.setMode("signin")}
              disabled={account.busy}
            >
              {accountRu.signIn}
            </button>
          )}
          {account.mode !== "signup" && (
            <button
              type="button"
              className="text-button"
              onClick={() => account.setMode("signup")}
              disabled={account.busy}
            >
              {accountRu.signUp}
            </button>
          )}
          {account.mode === "signin" && (
            <button
              type="button"
              className="text-button"
              onClick={() => account.setMode("recover")}
              disabled={account.busy}
            >
              {accountRu.forgot}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function WalkRow({
  walk,
  onOpenWalk,
}: {
  walk: SavedWalk;
  onOpenWalk: (walk: SavedWalk) => void;
}) {
  const account = useAccount();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(walk.title);
  const id = useId();
  return (
    <li className="account-row">
      <strong>{walk.title}</strong>
      <span className="account-muted">
        {accountRu.walkPlaces(walk.ordered_poi_ids.length)} ·{" "}
        {new Date(walk.created_at).toLocaleDateString("ru-RU")}
      </span>
      {editing && (
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            void account.renameWalk(walk.id, title).then((ok) => {
              if (ok) setEditing(false);
            });
          }}
        >
          <label htmlFor={id}>
            {accountRu.walkTitle}
            <input
              id={id}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={100}
              required
              disabled={account.busy}
            />
          </label>
          <div className="account-actions">
            <button
              type="submit"
              className="secondary-button"
              disabled={account.busy}
            >
              {accountRu.rename}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={account.busy}
              onClick={() => setEditing(false)}
            >
              {accountRu.cancel}
            </button>
          </div>
        </form>
      )}
      <div className="account-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            account.closeAccount();
            onOpenWalk(walk);
          }}
        >
          {accountRu.openWalk}
        </button>
        {!editing && (
          <button
            type="button"
            className="text-button"
            disabled={account.busy}
            onClick={() => {
              setTitle(walk.title);
              setEditing(true);
            }}
          >
            {accountRu.rename}
          </button>
        )}
        <button
          type="button"
          className="text-button"
          disabled={account.busy}
          onClick={() => void account.deleteWalk(walk.id)}
        >
          {accountRu.delete}
        </button>
      </div>
    </li>
  );
}

function Profile({
  onOpenPoi,
  onRoutePoi,
  onOpenWalk,
  resolvePoiName,
  currentPreferences,
  onApplyPreferences,
}: AccountDialogProps) {
  const account = useAccount();
  const [name, setName] = useState(account.profileName);
  const [confirmClear, setConfirmClear] = useState(false);
  const [places, setPlaces] = useState<Record<string, string>>({});
  const [placesLoading, setPlacesLoading] = useState(false);
  const [lookupError, setLookupError] = useState(false);
  useEffect(() => setName(account.profileName), [account.profileName]);
  useEffect(() => {
    if (!account.favorites.length) {
      setPlaces({});
      return;
    }
    const abort = new AbortController();
    setPlacesLoading(true);
    setLookupError(false);
    void (async () => {
      const names: Record<string, string> = {};
      for (let offset = 0; offset < account.favorites.length; offset += 100) {
        const response = await fetch("/api/pois/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            poi_ids: account.favorites.slice(offset, offset + 100),
          }),
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("place_lookup_failed");
        const data: { items: POI[] } = await response.json();
        data.items.forEach((poi) => {
          names[poi.id] = poi.name;
        });
      }
      if (!abort.signal.aborted) setPlaces(names);
    })()
      .catch(() => {
        if (!abort.signal.aborted) setLookupError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setPlacesLoading(false);
      });
    return () => abort.abort();
  }, [account.favorites]);
  return (
    <>
      <p className="account-muted">{account.user?.email}</p>
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          void account.saveName(name);
        }}
      >
        <label htmlFor="account-name">
          {accountRu.displayName}
          <input
            id="account-name"
            autoComplete="nickname"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={account.busy || account.loading}
          />
        </label>
        <button
          type="submit"
          className="secondary-button"
          disabled={account.busy || account.loading}
        >
          {accountRu.saveName}
        </button>
      </form>
      <div className="account-actions">
        <button
          type="button"
          className="text-button"
          disabled={account.loading || account.busy}
          onClick={() => void account.refresh()}
        >
          {accountRu.loadAgain}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={account.busy}
          onClick={() => void account.signOut()}
        >
          {accountRu.signOut}
        </button>
      </div>
      <h3>{accountRu.preferences}</h3>
      <p className="account-muted">{accountRu.preferencesHint}</p>
      <div className="account-actions">
        {currentPreferences && (
          <button
            type="button"
            className="secondary-button"
            disabled={account.busy || account.loading}
            onClick={() => void account.savePreferences(currentPreferences)}
          >
            {accountRu.savePreferences}
          </button>
        )}
        {onApplyPreferences && (
          <button
            type="button"
            className="text-button"
            disabled={
              account.busy ||
              account.loading ||
              !Object.keys(account.savedPreferences).length
            }
            onClick={() => {
              onApplyPreferences(account.savedPreferences);
              account.closeAccount();
            }}
          >
            {accountRu.applyPreferences}
          </button>
        )}
      </div>
      <h3>{accountRu.favorites}</h3>
      {lookupError && (
        <p className="account-error" role="alert">
          {accountRu.placeLookupError}
        </p>
      )}
      {!account.favorites.length && (
        <p className="account-muted">{accountRu.noFavorites}</p>
      )}
      <ul className="account-list">
        {account.favorites.map((poiId) => {
          const knownName = places[poiId] || resolvePoiName?.(poiId);
          return (
            <li key={poiId} className="account-row">
              <strong>
                {knownName ||
                  (placesLoading
                    ? accountRu.checkingPlace
                    : accountRu.missingPlace)}
              </strong>
              {!knownName && <span className="account-muted">{poiId}</span>}
              <div className="account-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    account.closeAccount();
                    onOpenPoi(poiId);
                  }}
                >
                  {accountRu.onMap}
                </button>
                {onRoutePoi && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      account.closeAccount();
                      onRoutePoi(poiId);
                    }}
                  >
                    {accountRu.route}
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={account.busy}
                  onClick={() => void account.toggleFavorite(poiId)}
                >
                  {accountRu.unfavorite}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <h3>{accountRu.savedWalks}</h3>
      <p className="account-muted">{accountRu.routeRefresh}</p>
      {!account.savedWalks.length && (
        <p className="account-muted">{accountRu.noWalks}</p>
      )}
      <ul className="account-list">
        {account.savedWalks.map((walk) => (
          <WalkRow key={walk.id} walk={walk} onOpenWalk={onOpenWalk} />
        ))}
      </ul>
      <p className="account-muted">{accountRu.privacy}</p>
      {!confirmClear ? (
        <button
          type="button"
          className="text-button"
          disabled={account.busy}
          onClick={() => setConfirmClear(true)}
        >
          {accountRu.clearData}
        </button>
      ) : (
        <div className="account-danger">
          <p>{accountRu.clearDataWarning}</p>
          <div className="account-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={account.busy}
              onClick={() =>
                void account.clearPersonalData().then((ok) => {
                  if (ok) setConfirmClear(false);
                })
              }
            >
              {accountRu.confirmClearData}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={account.busy}
              onClick={() => setConfirmClear(false)}
            >
              {accountRu.cancel}
            </button>
          </div>
        </div>
      )}
      <p className="account-muted">{accountRu.accountDeletion}</p>
    </>
  );
}

export default function AccountDialog(props: AccountDialogProps) {
  const account = useAccount();
  if (!account.dialogOpen) return null;
  const showProfile = account.user && account.mode !== "reset";
  const title = showProfile
    ? accountRu.account
    : account.mode === "signup"
      ? accountRu.signUp
      : account.mode === "recover"
        ? accountRu.recovery
        : account.mode === "reset"
          ? accountRu.reset
          : accountRu.signIn;
  return (
    <Modal title={title} onClose={account.closeAccount}>
      {!account.configured && (
        <p className="account-notice" role="status">
          {accountRu.unconfigured}
        </p>
      )}
      {account.loading && <p role="status">{accountRu.loading}</p>}
      {account.error && (
        <p className="account-error" role="alert">
          {account.error}
        </p>
      )}
      {account.notice && (
        <p className="account-notice" role="status">
          {account.notice}
        </p>
      )}
      {showProfile ? (
        <Profile key={account.user!.id} {...props} />
      ) : (
        <AuthForm key={account.mode} />
      )}
    </Modal>
  );
}
