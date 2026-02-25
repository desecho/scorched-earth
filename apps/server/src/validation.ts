import { z } from "zod";
import { MAX_ANGLE, MAX_POWER, MIN_ANGLE, MIN_POWER } from "@scorched-earth/shared";

export const joinRoomSchema = z.object({
  roomCode: z
    .string()
    .trim()
    .min(4)
    .max(8)
    .transform((value) => value.toUpperCase()),
  reconnectToken: z.string().trim().min(8).max(64).optional()
});

export const rejoinRoomSchema = z.object({
  roomCode: z
    .string()
    .trim()
    .min(4)
    .max(8)
    .transform((value) => value.toUpperCase()),
  reconnectToken: z.string().trim().min(8).max(64)
});

export const lockAimSchema = z.object({
  angleDeg: z.number().min(MIN_ANGLE).max(MAX_ANGLE),
  power: z.number().min(MIN_POWER).max(MAX_POWER)
});
