import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { accountRu } from "../i18n/ru";
import { authRedirect, supabase } from "./client";
import {
  isPoiId,
  safePreferences,
  type AccountMode,
  type SavedWalk,
  type SaveWalkInput,
  type WalkPreferences,
} from "./types";

type PendingAction =
  { kind: "favorite"; id: string } | { kind: "walk"; walk: SaveWalkInput };
type AccountContextValue = {
  user: User | null;
  configured: boolean;
  loading: boolean;
  busy: boolean;
  favorites: string[];
  savedWalks: SavedWalk[];
  profileName: string;
  savedPreferences: WalkPreferences;
  savePreferences: (preferences: WalkPreferences) => Promise<boolean>;
  error: string;
  notice: string;
  dialogOpen: boolean;
  mode: AccountMode;
  openAccount: () => void;
  closeAccount: () => void;
  setMode: (mode: AccountMode) => void;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => Promise<void>;
  saveWalk: (walk: SaveWalkInput) => Promise<void>;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<boolean>;
  signUp: (email: string, password: string) => Promise<boolean>;
  recover: (email: string) => Promise<boolean>;
  resetPassword: (password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  saveName: (name: string) => Promise<boolean>;
  renameWalk: (id: string, title: string) => Promise<boolean>;
  deleteWalk: (id: string) => Promise<void>;
  clearPersonalData: () => Promise<boolean>;
};
const AccountContext = createContext<AccountContextValue | null>(null);
const RECOVERY_STORAGE_KEY = "aitu-password-recovery-user";
function recoveryUser(): string | null {
  try {
    return sessionStorage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
}
function rememberRecovery(userId: string | null) {
  try {
    if (userId) sessionStorage.setItem(RECOVERY_STORAGE_KEY, userId);
    else sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    /* The current dialog still works when browser storage is unavailable. */
  }
}

function authError(error: unknown): string {
  const code =
    typeof error === "object" && error && "code" in error ? error.code : "";
  if (code === "invalid_credentials") return accountRu.invalidCredentials;
  if (code === "email_not_confirmed") return accountRu.confirmEmail;
  if (code === "weak_password" || code === "same_password")
    return accountRu.weakPassword;
  if (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit"
  )
    return accountRu.rateLimited;
  if (
    code === "otp_expired" ||
    code === "flow_state_expired" ||
    code === "flow_state_not_found"
  )
    return accountRu.expiredLink;
  return accountRu.authError;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [busy, setBusy] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [savedWalks, setSavedWalks] = useState<SavedWalk[]>([]);
  const [profileName, setProfileName] = useState("");
  const [savedPreferences, setSavedPreferences] = useState<WalkPreferences>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<AccountMode>("signin");
  const currentUser = useRef<string | null>(null);
  const lock = useRef(false);
  const pending = useRef<PendingAction | null>(null);
  const loadRevision = useRef(0);
  const authRevision = useRef(0);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const callback = new URL(window.location.href);
    const authReturn = callback.searchParams.get("auth");
    const callbackFailed =
      callback.searchParams.has("error") ||
      new URLSearchParams(callback.hash.slice(1)).has("error");
    const initialAuthRevision = authRevision.current;
    // The callback is synchronous: querying Supabase inside it can deadlock the SDK auth lock.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      ++authRevision.current;
      if (currentUser.current !== (session?.user.id ?? null)) {
        ++loadRevision.current;
        setFavorites([]);
        setSavedWalks([]);
        setProfileName("");
        setSavedPreferences({});
      }
      currentUser.current = session?.user.id ?? null;
      setUser(session?.user ?? null);
      if (event === "PASSWORD_RECOVERY") {
        rememberRecovery(session?.user.id ?? null);
        setMode("reset");
        setDialogOpen(true);
      }
      if (!session) {
        rememberRecovery(null);
        setFavorites([]);
        setSavedWalks([]);
        setProfileName("");
        setSavedPreferences({});
        setLoading(false);
      }
    });
    void supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!active) return;
        if (
          authRevision.current !== initialAuthRevision &&
          currentUser.current !== (data.session?.user.id ?? null)
        )
          return;
        currentUser.current = data.session?.user.id ?? null;
        setUser(data.session?.user ?? null);
        setLoading(false);
        if (sessionError || callbackFailed) {
          setError(authReturn ? accountRu.expiredLink : accountRu.sessionError);
          if (authReturn) setDialogOpen(true);
        } else if (
          data.session &&
          (authReturn === "recovery" || recoveryUser() === data.session.user.id)
        ) {
          rememberRecovery(data.session.user.id);
          setMode("reset");
          setDialogOpen(true);
        } else if (authReturn === "confirm") {
          setMode(data.session ? "profile" : "signin");
          setDialogOpen(true);
        }
        // Remove only authentication parameters after the SDK finishes its PKCE exchange.
        const clean = new URL(window.location.href);
        for (const name of [
          "code",
          "auth",
          "error",
          "error_code",
          "error_description",
        ])
          clean.searchParams.delete(name);
        if (
          /access_token=|refresh_token=|error=|type=recovery/.test(clean.hash)
        )
          clean.hash = "";
        if (clean.href !== window.location.href)
          window.history.replaceState(
            window.history.state,
            "",
            clean.pathname + clean.search + clean.hash,
          );
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError(accountRu.sessionError);
        }
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!supabase || !currentUser.current) return;
    const owner = currentUser.current;
    const revision = ++loadRevision.current;
    setLoading(true);
    try {
      const profile = await supabase
        .from("profiles")
        .select("display_name,preferences")
        .eq("id", owner)
        .maybeSingle();
      if (profile.error) throw profile.error;
      const favoriteRows: string[] = [];
      const walks: SavedWalk[] = [];
      // PostgREST has a default row limit; page rather than silently dropping older saves.
      for (let offset = 0; ; offset += 100) {
        const response = await supabase
          .from("favorites")
          .select("poi_id")
          .eq("user_id", owner)
          .order("created_at", { ascending: false })
          .order("id")
          .range(offset, offset + 99);
        if (response.error) throw response.error;
        favoriteRows.push(
          ...response.data.map((row) => row.poi_id as string).filter(isPoiId),
        );
        if (response.data.length < 100 || currentUser.current !== owner) break;
      }
      for (let offset = 0; ; offset += 100) {
        const response = await supabase
          .from("saved_walks")
          .select(
            "id,user_id,title,ordered_poi_ids,user_preferences,created_at,updated_at",
          )
          .eq("user_id", owner)
          .order("created_at", { ascending: false })
          .order("id")
          .range(offset, offset + 99);
        if (response.error) throw response.error;
        walks.push(
          ...(response.data as SavedWalk[]).map((walk) => ({
            ...walk,
            user_preferences: safePreferences(walk.user_preferences),
          })),
        );
        if (response.data.length < 100 || currentUser.current !== owner) break;
      }
      if (currentUser.current === owner && loadRevision.current === revision) {
        setProfileName(profile.data?.display_name ?? "");
        setSavedPreferences(safePreferences(profile.data?.preferences ?? {}));
        setFavorites(favoriteRows);
        setSavedWalks(walks);
        setError("");
      }
    } catch {
      if (currentUser.current === owner && loadRevision.current === revision)
        setError(accountRu.dataError);
    } finally {
      if (currentUser.current === owner && loadRevision.current === revision)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.id) void refresh();
    else {
      ++loadRevision.current;
    }
  }, [user?.id, refresh]);

  const run = useCallback(
    async (
      operation: () => Promise<void>,
      fallback = accountRu.saveError,
    ): Promise<boolean> => {
      if (!supabase || lock.current) return false;
      lock.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      const owner = currentUser.current;
      // A completed read must never resurrect values removed/edited by a later mutation.
      if (owner) {
        ++loadRevision.current;
        setLoading(false);
      }
      try {
        await operation();
        return true;
      } catch (failure) {
        if (owner === currentUser.current)
          setError(
            fallback === accountRu.authError ? authError(failure) : fallback,
          );
        return false;
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const applyAction = useCallback(
    async (action: PendingAction): Promise<boolean> => {
      const owner = currentUser.current;
      if (!supabase || !owner) return false;
      return run(async () => {
        ++loadRevision.current;
        setLoading(false);
        if (action.kind === "favorite") {
          // A guest save is always an insert; signing in must never remove an existing favorite.
          const response = await supabase!
            .from("favorites")
            .upsert(
              { user_id: owner, poi_id: action.id },
              { onConflict: "user_id,poi_id", ignoreDuplicates: true },
            );
          if (response.error) throw response.error;
          if (currentUser.current === owner) {
            setFavorites((old) =>
              old.includes(action.id) ? old : [action.id, ...old],
            );
            setNotice(accountRu.favoriteAdded);
          }
        } else {
          const response = await supabase!
            .from("saved_walks")
            .insert({ ...action.walk, user_id: owner })
            .select(
              "id,user_id,title,ordered_poi_ids,user_preferences,created_at,updated_at",
            )
            .single();
          if (response.error) throw response.error;
          if (currentUser.current === owner) {
            setSavedWalks((old) => [response.data as SavedWalk, ...old]);
            setNotice(accountRu.walkSaved);
          }
        }
      });
    },
    [run],
  );

  useEffect(() => {
    if (!user || loading || busy || !pending.current || mode === "reset")
      return;
    const action = pending.current;
    pending.current = null;
    void applyAction(action).then((ok) => {
      if (ok) setDialogOpen(false);
    });
  }, [user, loading, busy, mode, applyAction]);

  const requestAction = async (action: PendingAction) => {
    if (!supabase || !currentUser.current) {
      pending.current = action;
      setNotice(accountRu.savePrompt);
      setError("");
      setMode("signin");
      setDialogOpen(true);
      return;
    }
    if (loading) {
      pending.current = action;
      return;
    }
    await applyAction(action);
  };

  const toggleFavorite = async (id: string) => {
    if (!isPoiId(id)) return;
    if (!currentUser.current || !favorites.includes(id)) {
      await requestAction({ kind: "favorite", id });
      return;
    }
    const owner = currentUser.current;
    await run(async () => {
      const { error: failure } = await supabase!
        .from("favorites")
        .delete()
        .eq("user_id", owner)
        .eq("poi_id", id);
      if (failure) throw failure;
      if (currentUser.current === owner) {
        setFavorites((old) => old.filter((item) => item !== id));
        setNotice(accountRu.favoriteRemoved);
      }
    });
  };

  const saveWalk = async (input: SaveWalkInput) => {
    const walk = {
      title: input.title.trim(),
      ordered_poi_ids: [...input.ordered_poi_ids],
      user_preferences: safePreferences(input.user_preferences),
    };
    if (
      !walk.title ||
      walk.title.length > 100 ||
      !walk.ordered_poi_ids.length ||
      walk.ordered_poi_ids.length > 3 ||
      !walk.ordered_poi_ids.every(isPoiId) ||
      new Set(walk.ordered_poi_ids).size !== walk.ordered_poi_ids.length
    ) {
      setError(accountRu.invalidWalk);
      return;
    }
    await requestAction({ kind: "walk", walk });
  };

  const signIn = async (email: string, password: string) =>
    run(async () => {
      const { error: failure } = await supabase!.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (failure) throw failure;
      setMode("profile");
    }, accountRu.authError);
  const signUp = async (email: string, password: string) =>
    run(async () => {
      const { data, error: failure } = await supabase!.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: authRedirect("confirm") },
      });
      if (failure) throw failure;
      if (data.session) setMode("profile");
      else setNotice(accountRu.confirmationSent);
    }, accountRu.authError);
  const recover = async (email: string) =>
    run(async () => {
      const { error: failure } = await supabase!.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: authRedirect("recovery") },
      );
      if (failure) throw failure;
      setNotice(accountRu.recoverySent);
    }, accountRu.authError);
  const resetPassword = async (password: string) =>
    run(async () => {
      const { error: failure } = await supabase!.auth.updateUser({ password });
      if (failure) throw failure;
      rememberRecovery(null);
      setMode("profile");
      setNotice(accountRu.passwordSaved);
    }, accountRu.authError);

  const signOut = async () => {
    pending.current = null;
    await run(async () => {
      const { error: failure } = await supabase!.auth.signOut({
        scope: "local",
      });
      if (failure) throw failure;
      rememberRecovery(null);
      currentUser.current = null;
      ++loadRevision.current;
      setUser(null);
      setFavorites([]);
      setSavedWalks([]);
      setProfileName("");
      setSavedPreferences({});
      setLoading(false);
      setMode("signin");
      setNotice(accountRu.signedOut);
    }, accountRu.signOutError);
  };
  const saveName = async (name: string) => {
    const displayName = name.trim();
    if (!displayName || displayName.length > 80) {
      setError(accountRu.invalidName);
      return false;
    }
    const owner = currentUser.current;
    if (!owner) return false;
    return run(async () => {
      // Separate insert/update avoids granting UPDATE on immutable id for an upsert.
      const existing = await supabase!
        .from("profiles")
        .select("id")
        .eq("id", owner)
        .maybeSingle();
      if (existing.error) throw existing.error;
      const result = existing.data
        ? await supabase!
            .from("profiles")
            .update({ display_name: displayName })
            .eq("id", owner)
        : await supabase!
            .from("profiles")
            .insert({ id: owner, display_name: displayName });
      if (result.error) throw result.error;
      if (currentUser.current === owner) {
        setProfileName(displayName);
        setNotice(accountRu.nameSaved);
      }
    });
  };
  const renameWalk = async (id: string, title: string) => {
    if (!title.trim() || title.trim().length > 100) {
      setError(accountRu.invalidWalk);
      return false;
    }
    const owner = currentUser.current;
    if (!owner) return false;
    return run(async () => {
      const { error: failure } = await supabase!
        .from("saved_walks")
        .update({ title: title.trim() })
        .eq("id", id)
        .eq("user_id", owner);
      if (failure) throw failure;
      if (currentUser.current === owner) {
        setSavedWalks((old) =>
          old.map((walk) =>
            walk.id === id ? { ...walk, title: title.trim() } : walk,
          ),
        );
        setNotice(accountRu.renameSaved);
      }
    });
  };
  const savePreferences = async (input: WalkPreferences) => {
    const owner = currentUser.current;
    if (!owner) return false;
    const preferences = safePreferences(input);
    return run(async () => {
      const existing = await supabase!
        .from("profiles")
        .select("id")
        .eq("id", owner)
        .maybeSingle();
      if (existing.error) throw existing.error;
      const result = existing.data
        ? await supabase!
            .from("profiles")
            .update({ preferences })
            .eq("id", owner)
        : await supabase!.from("profiles").insert({ id: owner, preferences });
      if (result.error) throw result.error;
      if (currentUser.current === owner) {
        setSavedPreferences(preferences);
        setNotice(accountRu.preferencesSaved);
      }
    });
  };
  const deleteWalk = async (id: string) => {
    const owner = currentUser.current;
    if (!owner) return;
    await run(async () => {
      const { error: failure } = await supabase!
        .from("saved_walks")
        .delete()
        .eq("id", id)
        .eq("user_id", owner);
      if (failure) throw failure;
      if (currentUser.current === owner) {
        setSavedWalks((old) => old.filter((walk) => walk.id !== id));
        setNotice(accountRu.deleted);
      }
    });
  };
  const clearPersonalData = async () => {
    const owner = currentUser.current;
    if (!owner) return false;
    return run(async () => {
      const { error: failure } = await supabase!.rpc(
        "aitu_delete_my_personal_data",
      );
      if (failure) throw failure;
      if (currentUser.current === owner) {
        ++loadRevision.current;
        setLoading(false);
        setFavorites([]);
        setSavedWalks([]);
        setProfileName("");
        setSavedPreferences({});
        setNotice(accountRu.dataCleared);
      }
    });
  };

  return (
    <AccountContext.Provider
      value={{
        user,
        configured: Boolean(supabase),
        loading,
        busy,
        favorites,
        savedWalks,
        profileName,
        savedPreferences,
        savePreferences,
        error,
        notice,
        dialogOpen,
        mode,
        setMode,
        openAccount: () => {
          setMode((current) =>
            user && current === "reset" ? "reset" : user ? "profile" : "signin",
          );
          setDialogOpen(true);
        },
        closeAccount: () => {
          pending.current = null;
          setDialogOpen(false);
        },
        isFavorite: (id) => favorites.includes(id),
        toggleFavorite,
        saveWalk,
        refresh,
        signIn,
        signUp,
        recover,
        resetPassword,
        signOut,
        saveName,
        renameWalk,
        deleteWalk,
        clearPersonalData,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is required");
  return value;
}
