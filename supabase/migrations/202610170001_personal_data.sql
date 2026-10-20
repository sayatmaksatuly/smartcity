-- AITU KEREK Phase 5. Apply once in the EXISTING Supabase project's SQL Editor.
-- Atomic and non-destructive: an existing conflicting object aborts this migration.
-- Never disable email confirmation or introduce a service_role key in the browser.
begin;

create function public.aitu_walk_preferences_valid(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(value) = 'object'
    and octet_length(value::text) <= 2048
    and (value - array['duration_minutes','categories','travel_mode','round_trip','open_now','free_only']) = '{}'::jsonb
    and (not (value ? 'duration_minutes') or case
      when jsonb_typeof(value->'duration_minutes') = 'number'
      then (value->>'duration_minutes')::numeric between 15 and 240
        and mod((value->>'duration_minutes')::numeric, 1) = 0 else false end)
    and (not (value ? 'categories') or (
      jsonb_typeof(value->'categories') = 'array'
      and value->'categories' <@ '["park","culture","landmark","cafe","recreation","venue"]'::jsonb))
    and (not (value ? 'travel_mode') or value->>'travel_mode' in ('walking','cycling'))
    and (not (value ? 'round_trip') or jsonb_typeof(value->'round_trip') = 'boolean')
    and (not (value ? 'open_now') or jsonb_typeof(value->'open_now') = 'boolean')
    and (not (value ? 'free_only') or jsonb_typeof(value->'free_only') = 'boolean'), false);
$$;
revoke all on function public.aitu_walk_preferences_valid(jsonb) from public, anon;
grant execute on function public.aitu_walk_preferences_valid(jsonb) to authenticated;

create function public.aitu_walk_ids_valid(value text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(array_ndims(value) = 1
    and cardinality(value) between 1 and 3
    and (select count(distinct item) = cardinality(value)
      and bool_and(char_length(item) <= 40 and item ~ '^(node|way|relation)/[1-9][0-9]*$')
      from unnest(value) as item), false);
$$;
revoke all on function public.aitu_walk_ids_valid(text[]) from public, anon;
grant execute on function public.aitu_walk_ids_valid(text[]) to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  display_name text not null default '' check (char_length(display_name) <= 80),
  preferences jsonb not null default '{}'::jsonb check (public.aitu_walk_preferences_valid(preferences)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  poi_id text not null check (char_length(poi_id) <= 40 and poi_id ~ '^(node|way|relation)/[1-9][0-9]*$'),
  created_at timestamptz not null default now(),
  constraint favorites_user_poi_unique unique(user_id, poi_id)
);
create index favorites_owner_created_idx on public.favorites(user_id, created_at desc);

create table public.saved_walks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  ordered_poi_ids text[] not null check (public.aitu_walk_ids_valid(ordered_poi_ids)),
  user_preferences jsonb not null default '{}'::jsonb check (public.aitu_walk_preferences_valid(user_preferences)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_walks_owner_created_idx on public.saved_walks(user_id, created_at desc);

create function public.aitu_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.aitu_touch_updated_at() from public, anon, authenticated;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.aitu_touch_updated_at();
create trigger saved_walks_updated_at before update on public.saved_walks
  for each row execute function public.aitu_touch_updated_at();

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.favorites enable row level security;
alter table public.favorites force row level security;
alter table public.saved_walks enable row level security;
alter table public.saved_walks force row level security;

-- Explicit least privilege, including projects with automatic API grants disabled.
revoke all on public.profiles, public.favorites, public.saved_walks from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, delete on public.profiles, public.favorites, public.saved_walks to authenticated;
grant insert (id, display_name, preferences) on public.profiles to authenticated;
grant update (display_name, preferences) on public.profiles to authenticated;
grant insert (user_id, poi_id) on public.favorites to authenticated;
grant insert (user_id, title, ordered_poi_ids, user_preferences) on public.saved_walks to authenticated;
grant update (title, ordered_poi_ids, user_preferences) on public.saved_walks to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy profiles_delete_own on public.profiles for delete to authenticated using ((select auth.uid()) = id);
create policy favorites_select_own on public.favorites for select to authenticated using ((select auth.uid()) = user_id);
create policy favorites_insert_own on public.favorites for insert to authenticated with check ((select auth.uid()) = user_id);
create policy favorites_delete_own on public.favorites for delete to authenticated using ((select auth.uid()) = user_id);
create policy saved_walks_select_own on public.saved_walks for select to authenticated using ((select auth.uid()) = user_id);
create policy saved_walks_insert_own on public.saved_walks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy saved_walks_update_own on public.saved_walks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy saved_walks_delete_own on public.saved_walks for delete to authenticated using ((select auth.uid()) = user_id);

-- Invoker RPC: atomic deletion only of the caller's app data, subject to the same RLS.
-- It deliberately does NOT delete auth.users or impersonate an admin account.
create function public.aitu_delete_my_personal_data()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  delete from public.favorites where user_id = (select auth.uid());
  delete from public.saved_walks where user_id = (select auth.uid());
  delete from public.profiles where id = (select auth.uid());
end;
$$;
revoke all on function public.aitu_delete_my_personal_data() from public, anon;
grant execute on function public.aitu_delete_my_personal_data() to authenticated;
commit;
