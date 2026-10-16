import { z } from "zod";

// Built-in authentication contracts. Like attention.ts, this module imports
// only zod and never imports index.ts.

export const authErrorCodeSchema = z.enum([
  "INVALID_CREDENTIALS",
  "SIGNUP_CLOSED",
  "INVITE_REQUIRED",
  "SETUP_TOKEN_REQUIRED",
  "EMAIL_TAKEN",
  "REFRESH_TOKEN_INVALID",
  "PASSWORD_INCORRECT"
]);

export const signupModeSchema = z.enum(["invite", "open", "closed"]);
export type SignupMode = z.infer<typeof signupModeSchema>;

const emailSchema = z.string().trim().toLowerCase().max(320).email();
// Mirrors PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH in @orchestrat/auth.
const passwordSchema = z.string().min(10).max(256);
const fullNameSchema = z.string().trim().min(1).max(120);

export const authInstanceResponseSchema = z.object({
  needs_setup: z.boolean(),
  signup_mode: signupModeSchema
});
export type AuthInstanceResponse = z.infer<typeof authInstanceResponseSchema>;

export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  full_name: fullNameSchema,
  invite_token: z.string().min(1).max(512).optional(),
  // Required for the first account on an empty instance; the server prints
  // it in its log at startup (or reads ORCHESTRAT_SETUP_TOKEN).
  setup_token: z.string().min(1).max(512).optional()
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256)
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refresh_token: z.string().min(1).max(512)
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const changePasswordRequestSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: passwordSchema
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const authSessionResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().positive(),
  user: z.object({
    user_id: z.string().uuid(),
    email: z.string(),
    full_name: z.string(),
    is_instance_admin: z.boolean()
  }),
  // Set when a sign-up accepted a project invite.
  invited_project_id: z.string().uuid().nullable().optional()
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
