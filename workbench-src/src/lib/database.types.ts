// Hand-maintained mirror of supabase/migrations/0001_init.sql. Keep the two in sync when the
// schema changes — `supabase gen types typescript` can regenerate this file wholesale once the
// CLI is wired into the project.

export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface Computer {
  id: string;
  host_id: string;
  owner_id: string;
  name: string;
  machine_name: string | null;
  os: string | null;
  app_version: string | null;
  host_token_hash: string;
  pin_hash: string | null;
  screen_width: number | null;
  screen_height: number | null;
  monitor_count: number;
  online: boolean;
  last_seen_at: string | null;
  created_at: string;
}

export interface ComputerAccess {
  id: string;
  computer_id: string;
  account_id: string;
  role: "owner" | "guest";
  granted_by: string | null;
  last_connected_at: string | null;
  created_at: string;
}

export interface EnrollmentKey {
  id: string;
  owner_id: string;
  key_hash: string;
  key_prefix: string;
  label: string | null;
  expires_at: string;
  used_at: string | null;
  computer_id: string | null;
  created_at: string;
}

export interface ConnectionEvent {
  id: string;
  computer_id: string | null;
  account_id: string | null;
  kind: "connected" | "disconnected" | "denied" | "enrolled" | "pin-connect";
  detail: string | null;
  created_at: string;
}

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      profiles: Table<Profile>;
      computers: Table<Computer>;
      computer_access: Table<ComputerAccess>;
      enrollment_keys: Table<EnrollmentKey>;
      connection_events: Table<ConnectionEvent>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
