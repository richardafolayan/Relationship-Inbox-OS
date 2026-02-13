import { z } from "zod";

export const runnerEventSchema = z.object({
  eventId: z.number().int().positive(),
  jobId: z.string(),
  at: z.string(),
  type: z.string()
});

export type ParsedRunnerEvent = z.infer<typeof runnerEventSchema>;
