// ВНИМАНИЕ: файл сгенерирован из старого проекта Supabase и отстаёт от живой
// схемы (источник правды — db/*.sql в корне репозитория). Колонки с
// пометкой /* patched */ добавлены вручную и проверены запросом к живой БД.
// TODO: перегенерировать целиком через `supabase gen types typescript`
// (нужен access token владельца).
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      clients: {
        Row: {
          avatar_url: string | null;
          birthday: string | null;
          created_at: string;
          email: string | null;
          first_name: string | null;
          full_name: string | null;
          gender: string | null;
          id: string;
          last_name: string | null;
          phone: string | null;
          studio_id: string; /* patched */
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          birthday?: string | null;
          created_at?: string;
          email?: string | null;
          first_name?: string | null;
          full_name?: string | null;
          gender?: string | null;
          id?: string;
          last_name?: string | null;
          phone?: string | null;
          studio_id?: string; /* patched */
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          birthday?: string | null;
          created_at?: string;
          email?: string | null;
          first_name?: string | null;
          full_name?: string | null;
          gender?: string | null;
          id?: string;
          last_name?: string | null;
          phone?: string | null;
          studio_id?: string; /* patched */
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      app_install_settings: {
        /* patched: 2026-10-11_zzzzzzzzzz_app_content_by_studio.sql */
        Row: {
          app_icon_path: string | null;
          app_name: string | null;
          format: string;
          updated_at: string;
        };
        Insert: {
          app_icon_path?: string | null;
          app_name?: string | null;
          format: string;
          updated_at?: string;
        };
        Update: {
          app_icon_path?: string | null;
          app_name?: string | null;
          format?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      club_settings: {
        Row: {
          app_icon_path: string | null; /* patched: 2026-10-11_app_install_settings.sql */
          app_name: string | null; /* patched */
          call_url: string | null;
          cancel_booking_minutes: number;
          feedback_url: string | null;
          id: boolean;
          updated_at: string;
          write_url: string | null;
        };
        Insert: {
          app_icon_path?: string | null; /* patched */
          app_name?: string | null; /* patched */
          call_url?: string | null;
          cancel_booking_minutes?: number;
          feedback_url?: string | null;
          id?: boolean;
          updated_at?: string;
          write_url?: string | null;
        };
        Update: {
          app_icon_path?: string | null; /* patched */
          app_name?: string | null; /* patched */
          call_url?: string | null;
          cancel_booking_minutes?: number;
          feedback_url?: string | null;
          id?: boolean;
          updated_at?: string;
          write_url?: string | null;
        };
        Relationships: [];
      };
      member_profiles: {
        Row: {
          birth_date: string | null; /* patched: 2026-10-11_packages_onboarding.sql */
          birth_year: number | null;
          created_at: string;
          current_weekly_activity: number | null;
          desired_frequency: number | null;
          experience_level: string | null;
          gender: string | null;
          goal_other: string | null; /* patched: 2026-10-11_packages_onboarding.sql */
          goal_motivation: string | null;
          health_flags: string[];
          health_notes: string | null;
          height_cm: number | null;
          onboarding_completed_at: string | null;
          preferred_times: string[];
          primary_goal: string | null;
          referral_source: string | null;
          target_timeframe: string | null;
          tried_group_hiit: boolean | null;
          updated_at: string;
          user_id: string;
          weight_kg: number | null;
        };
        Insert: {
          birth_date?: string | null; /* patched: 2026-10-11_packages_onboarding.sql */
          birth_year?: number | null;
          created_at?: string;
          current_weekly_activity?: number | null;
          desired_frequency?: number | null;
          experience_level?: string | null;
          gender?: string | null;
          goal_other?: string | null; /* patched: 2026-10-11_packages_onboarding.sql */
          goal_motivation?: string | null;
          health_flags?: string[];
          health_notes?: string | null;
          height_cm?: number | null;
          onboarding_completed_at?: string | null;
          preferred_times?: string[];
          primary_goal?: string | null;
          referral_source?: string | null;
          target_timeframe?: string | null;
          tried_group_hiit?: boolean | null;
          updated_at?: string;
          user_id: string;
          weight_kg?: number | null;
        };
        Update: {
          birth_date?: string | null; /* patched: 2026-10-11_packages_onboarding.sql */
          birth_year?: number | null;
          created_at?: string;
          current_weekly_activity?: number | null;
          desired_frequency?: number | null;
          experience_level?: string | null;
          gender?: string | null;
          goal_other?: string | null; /* patched: 2026-10-11_packages_onboarding.sql */
          goal_motivation?: string | null;
          health_flags?: string[];
          health_notes?: string | null;
          height_cm?: number | null;
          onboarding_completed_at?: string | null;
          preferred_times?: string[];
          primary_goal?: string | null;
          referral_source?: string | null;
          target_timeframe?: string | null;
          tried_group_hiit?: boolean | null;
          updated_at?: string;
          user_id?: string;
          weight_kg?: number | null;
        };
        Relationships: [];
      };
      news: {
        Row: {
          banner_url: string | null;
          button_text: string | null;
          button_url: string | null;
          created_at: string;
          description: string | null;
          full_text: string | null;
          full_title: string | null;
          id: string;
          image_url: string | null;
          position: number;
          studio_id: string; /* patched */
          studio_ids: string[]; /* patched: 2026-10-11_zzzzzzzzzz_app_content_by_studio.sql */
          published: boolean;
          title: string;
          translations: Json; /* patched: 2026-10-12_zzzzzz_content_translations.sql */
          updated_at: string;
        };
        Insert: {
          banner_url?: string | null;
          button_text?: string | null;
          button_url?: string | null;
          created_at?: string;
          description?: string | null;
          full_text?: string | null;
          full_title?: string | null;
          id?: string;
          image_url?: string | null;
          position?: number;
          studio_id?: string; /* patched */
          published?: boolean;
          title: string;
          updated_at?: string;
        };
        Update: {
          banner_url?: string | null;
          button_text?: string | null;
          button_url?: string | null;
          created_at?: string;
          description?: string | null;
          full_text?: string | null;
          full_title?: string | null;
          id?: string;
          image_url?: string | null;
          position?: number;
          studio_id?: string; /* patched */
          published?: boolean;
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      schedule_bookings: {
        Row: {
          cancelled_at: string | null;
          created_at: string;
          entry_id: string;
          id: string;
          status: Database["public"]["Enums"]["booking_status"];
          user_id: string;
        };
        Insert: {
          cancelled_at?: string | null;
          created_at?: string;
          entry_id: string;
          id?: string;
          status?: Database["public"]["Enums"]["booking_status"];
          user_id: string;
        };
        Update: {
          cancelled_at?: string | null;
          created_at?: string;
          entry_id?: string;
          id?: string;
          status?: Database["public"]["Enums"]["booking_status"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "schedule_bookings_entry_id_fkey";
            columns: ["entry_id"];
            isOneToOne: false;
            referencedRelation: "schedule_entries";
            referencedColumns: ["id"];
          },
        ];
      };
      schedule_entries: {
        Row: {
          booked_count: number;
          /* patched: db/migrations/2026-10-11_zzzzzzz_entry_cancel_no_show.sql */
          cancelled_at: string | null;
          capacity: number | null;
          created_at: string;
          ends_at: string;
          id: string;
          /* patched: db/migrations/2026-10-11_schedule_activity_kinds.sql */
          kind: "group" | "personal" | "other";
          starts_at: string;
          studio_id: string; /* patched */
          workout_id: string | null;
        };
        Insert: {
          booked_count?: number;
          capacity?: number | null;
          created_at?: string;
          ends_at: string;
          id?: string;
          starts_at: string;
          workout_id?: string | null;
        };
        Update: {
          booked_count?: number;
          capacity?: number | null;
          created_at?: string;
          ends_at?: string;
          id?: string;
          starts_at?: string;
          studio_id?: string; /* patched */
          workout_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "schedule_entries_workout_id_fkey";
            columns: ["workout_id"];
            isOneToOne: false;
            referencedRelation: "workouts";
            referencedColumns: ["id"];
          },
        ];
      };
      /* patched: db/migrations/2026-10-09_studio_formats.sql; приложению studios
         доступна только на чтение — Insert/Update не описаны */
      studio_app_settings: {
        /* patched: 2026-10-11_zzzzzzzzzz_app_content_by_studio.sql */
        Row: {
          call_url: string | null;
          cancel_booking_minutes: number;
          feedback_url: string | null;
          studio_id: string;
          translations: Json; /* patched: 2026-10-12_zzzzzz_content_translations.sql */
          updated_at: string;
          write_url: string | null;
        };
        Insert: {
          call_url?: string | null;
          cancel_booking_minutes?: number;
          feedback_url?: string | null;
          studio_id: string;
          updated_at?: string;
          write_url?: string | null;
        };
        Update: {
          call_url?: string | null;
          cancel_booking_minutes?: number;
          feedback_url?: string | null;
          studio_id?: string;
          updated_at?: string;
          write_url?: string | null;
        };
        Relationships: [];
      };
      studios: {
        Row: {
          brand_color: string;
          created_at: string;
          format: "subscription" | "packages";
          id: string;
          logo_url: string | null;
          name: string;
          slug: string;
          translations: Json; /* patched: 2026-10-12_zzzzzz_content_translations.sql */
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      workouts: {
        Row: {
          capacity: number | null;
          created_at: string;
          id: string;
          name: string;
          translations: Json; /* patched: 2026-10-12_zzzzzz_content_translations.sql */
          type: string | null;
        };
        Insert: {
          capacity?: number | null;
          created_at?: string;
          id?: string;
          name: string;
          type?: string | null;
        };
        Update: {
          capacity?: number | null;
          created_at?: string;
          id?: string;
          name?: string;
          type?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      book_schedule_entry: { Args: { p_entry_id: string }; Returns: Json };
      cancel_schedule_booking: { Args: { p_entry_id: string }; Returns: Json };
      get_my_stats: { Args: never; Returns: Json };
    };
    Enums: {
      booking_status: "booked" | "cancelled";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      booking_status: ["booked", "cancelled"],
    },
  },
} as const;
