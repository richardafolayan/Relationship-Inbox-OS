import type { OperatorProfile } from "../types/runtime";
import type { AiFidelityCase } from "./ai-fidelity-types";

export const AI_FIDELITY_EVALUATION_NOW = new Date("2026-07-10T12:00:00.000Z");

function profile(input: Partial<OperatorProfile> & Pick<OperatorProfile, "displayName">): OperatorProfile {
  return {
    displayName: input.displayName,
    about: input.about ?? "",
    interests: input.interests ?? "",
    commonPhrases: input.commonPhrases ?? "",
    avoidedPhrases: input.avoidedPhrases ?? "",
    preferredStyle: input.preferredStyle ?? "",
    aiHelpLevel: "full_drafts",
    setupCompletedAt: "2026-06-01T09:00:00.000Z",
    focusWindow: {
      active: false,
      startedAt: "",
      endsAt: "",
      reason: "",
      note: "",
      professionalNote: "",
      audience: "favourites",
      windowId: "",
      ackedPersonIds: []
    },
    ackTemplates: { close: "", professional: "" },
    focusSettings: { reasonLabel: true, oneNotePerPerson: true, audience: "favourites" }
  };
}

export const AI_FIDELITY_CASES: AiFidelityCase[] = [
  {
    id: "short-scheduling-two-asks",
    title: "Short scheduling message with two explicit asks",
    tags: ["short_conversation", "new_replies", "action_items"],
    platform: "IMESSAGE",
    displayName: "Mina",
    previousOpenLoops: [],
    messages: [
      {
        direction: "IN",
        text: "Can you send the lab notes today and tell me if 3pm tomorrow works?",
        timestamp: "2026-07-10T10:00:00.000Z"
      }
    ],
    operatorProfile: profile({
      displayName: "Sam",
      about: "I reply clearly and briefly.",
      preferredStyle: "concise"
    }),
    expected: {
      state: { needsReply: true, minRequiredPoints: 2, maxRequiredPoints: 3 },
      facts: [
        { id: "lab-notes", anyOf: ["lab notes?"], rationale: "The requested item must stay specific." },
        { id: "three-tomorrow", anyOf: ["3\\s*(?:pm|p\\.?m\\.?).*tomorrow", "tomorrow.*3"], rationale: "The proposed time must be retained." }
      ],
      forbiddenFactualClaims: [
        { id: "invented-time", anyOf: ["4\\s*pm", "friday", "tonight"], rationale: "No other time or day was proposed." }
      ],
      actionItems: [
        { id: "send-notes", anyOf: ["send.*lab notes?", "lab notes?.*send"], rationale: "Sending the notes is an explicit ask." },
        { id: "confirm-time", anyOf: ["(?:confirm|say|tell|answer|whether|if).*3\\s*pm", "3\\s*pm.*(?:work|confirm)"], rationale: "The operator must answer whether the time works." }
      ],
      forbiddenActionItems: [],
      replyBeats: [
        { id: "reply-notes", anyOf: ["(?:send|share).*notes?", "notes?.*(?:today|over)"], rationale: "A useful reply addresses the notes." },
        { id: "reply-time", anyOf: ["3\\s*pm", "three.*tomorrow"], rationale: "A useful reply addresses the proposed time." }
      ],
      identityForbidden: [],
      voicePreferredAnyOf: [],
      voiceAvoided: [],
      minimumReplies: 3
    },
    rubric: [
      "Keep both asks separate.",
      "Do not invent another time or a call.",
      "Each suggested reply should answer both the notes and 3pm question."
    ]
  },
  {
    id: "long-old-context-new-contract",
    title: "Long interrupted thread where old asks are resolved and a new reply changes state",
    tags: [
      "long_conversation",
      "interruptions",
      "old_context",
      "new_replies",
      "already_answered_points",
      "action_items"
    ],
    platform: "WHATSAPP",
    displayName: "Leila",
    previousSummary: "You and Leila have been comparing placements and summer plans.",
    previousOpenLoops: ["Choose a campsite", "Ask for the reading list"],
    messages: [
      { direction: "IN", text: "Want to camp in the Lakes in May?", timestamp: "2026-04-01T09:00:00.000Z" },
      { direction: "OUT", text: "Yeah, booked the Keswick site for 18 May", timestamp: "2026-04-01T11:00:00.000Z" },
      { direction: "IN", text: "Perfect, Keswick on the 18th is sorted", timestamp: "2026-04-01T11:30:00.000Z" },
      { direction: "IN", text: "I'll send that placement reading list later", timestamp: "2026-04-04T08:00:00.000Z" },
      { direction: "OUT", text: "No rush", timestamp: "2026-04-04T09:00:00.000Z" },
      { direction: "IN", text: "Here it is https://example.test/reading", timestamp: "2026-04-04T12:00:00.000Z" },
      { direction: "OUT", text: "Got it thanks", timestamp: "2026-04-04T12:10:00.000Z" },
      { direction: "IN", text: "Random interruption, did you see the meteor shower?", timestamp: "2026-04-20T22:00:00.000Z" },
      { direction: "OUT", text: "Missed it completely", timestamp: "2026-04-20T22:05:00.000Z" },
      { direction: "IN", text: "Exams are chaos so I might disappear for a week", timestamp: "2026-05-02T16:00:00.000Z" },
      { direction: "OUT", text: "All good, focus on them", timestamp: "2026-05-02T16:30:00.000Z" },
      { direction: "IN", text: "Done now, survived somehow", timestamp: "2026-05-12T18:00:00.000Z" },
      { direction: "OUT", text: "Knew you would", timestamp: "2026-05-12T18:15:00.000Z" },
      { direction: "OUT", text: "How did the placement interview go?", timestamp: "2026-07-09T18:00:00.000Z" },
      {
        direction: "IN",
        text: "Got it! They offered me the Manchester role and I said yes. I start 2 September. Could you look over the contract by Sunday? Mum's surgery moved to August but the date isn't confirmed.",
        timestamp: "2026-07-10T08:30:00.000Z"
      }
    ],
    operatorProfile: profile({
      displayName: "Owen",
      about: "Warm and practical, usually two short sentences.",
      commonPhrases: "nice one\nglad to hear it",
      preferredStyle: "warm"
    }),
    expected: {
      state: { needsReply: true, minRequiredPoints: 1, maxRequiredPoints: 3 },
      facts: [
        { id: "manchester-role", anyOf: ["Manchester role", "role.*Manchester"], rationale: "The accepted role is current reply-relevant news." },
        { id: "start-date", anyOf: ["2(?:nd)? September", "September 2"], rationale: "The stated start date is important and exact." },
        { id: "contract-deadline", anyOf: ["contract.*Sunday", "Sunday.*contract"], rationale: "The live ask has a deadline." },
        { id: "surgery-uncertain", anyOf: ["surgery.*August", "August.*surgery", "date isn['’]?t confirmed"], rationale: "The family update must retain its uncertainty." }
      ],
      forbiddenFactualClaims: [
        { id: "invented-role", anyOf: ["London role", "Birmingham role"], rationale: "The role is in Manchester." },
        { id: "invented-surgery-date", anyOf: ["surgery.*(?:1|2|3|4|5|6|7|8|9|1[0-9]|2[0-9]|3[01])(?:st|nd|rd|th)? August"], rationale: "No surgery date is confirmed." }
      ],
      actionItems: [
        { id: "review-contract", anyOf: ["(?:review|look over|read|check).*contract", "contract.*(?:Sunday|review|check)"], rationale: "This is the only explicit live request." }
      ],
      forbiddenActionItems: [
        { id: "resolved-campsite", anyOf: ["(?:choose|book|confirm).*camp", "campsite"], rationale: "The campsite was booked and confirmed months ago." },
        { id: "resolved-reading-list", anyOf: ["(?:ask|chase|request).*reading list"], rationale: "The reading list was sent and acknowledged." }
      ],
      replyBeats: [
        { id: "reply-contract", anyOf: ["contract", "look it over", "review it"], rationale: "Every sendable reply must address the request." },
        { id: "reply-role", anyOf: ["Manchester", "role", "congrat"], rationale: "A thoughtful reply acknowledges the accepted role." },
        { id: "reply-family", anyOf: ["mum", "surgery", "August"], rationale: "A thoughtful reply acknowledges the family update without fixing a date." }
      ],
      identityForbidden: [
        { id: "role-owner-flip", anyOf: ["(?:my|I start).*Manchester role", "my new role"], rationale: "The role belongs to Leila, not Owen." },
        { id: "surgery-owner-flip", anyOf: ["my mum['’]?s surgery"], rationale: "The surgery update belongs to Leila's family." }
      ],
      voicePreferredAnyOf: ["nice one", "glad", "congrat"],
      voiceAvoided: [],
      minimumReplies: 3
    },
    rubric: [
      "Prioritise the latest inbound below the live exchange boundary.",
      "Do not resurrect the campsite or reading-list loops.",
      "Keep the August surgery date explicitly unconfirmed.",
      "Keep Leila's role and family circumstances attached to Leila."
    ]
  },
  {
    id: "multi-topic-unresolved-promise",
    title: "Multi-topic update with an unresolved promise and two new actions",
    tags: ["multi_topic", "unresolved_promises", "action_items", "new_replies"],
    platform: "WHATSAPP",
    displayName: "Tariq",
    previousOpenLoops: ["Send the revised budget"],
    messages: [
      { direction: "OUT", text: "I'll send the revised budget on Friday", timestamp: "2026-07-03T10:00:00.000Z" },
      { direction: "IN", text: "Great, thanks", timestamp: "2026-07-03T10:10:00.000Z" },
      {
        direction: "IN",
        text: "Venue is confirmed at North Hall. I'm still waiting on the revised budget. Can you invite Jo and send the dietary numbers by Wednesday? Also I passed my driving test!",
        timestamp: "2026-07-10T09:00:00.000Z"
      }
    ],
    operatorProfile: profile({
      displayName: "Elena",
      about: "Friendly, organised and concise.",
      commonPhrases: "amazing\nwill do",
      preferredStyle: "direct"
    }),
    expected: {
      state: { needsReply: true, minRequiredPoints: 3, maxRequiredPoints: 4 },
      facts: [
        { id: "north-hall", anyOf: ["North Hall"], rationale: "The confirmed venue is useful context, not a task." },
        { id: "waiting-budget", anyOf: ["waiting.*revised budget", "revised budget.*waiting"], rationale: "The old promise remains unresolved." },
        { id: "invite-jo", anyOf: ["invite Jo"], rationale: "This is a new explicit action." },
        { id: "dietary-wednesday", anyOf: ["dietary.*Wednesday", "Wednesday.*dietary"], rationale: "This action includes a deadline." },
        { id: "driving-test", anyOf: ["passed.*driving test", "driving test.*pass"], rationale: "The personal news deserves acknowledgement." }
      ],
      forbiddenFactualClaims: [
        { id: "invented-venue", anyOf: ["South Hall", "Town Hall"], rationale: "Only North Hall was named." },
        { id: "invented-budget-sent", anyOf: ["budget (?:was|is|has been) sent", "already sent.*budget"], rationale: "The budget is still outstanding." }
      ],
      actionItems: [
        { id: "budget", anyOf: ["send.*revised budget", "revised budget.*send"], rationale: "The explicit promise is still open." },
        { id: "jo", anyOf: ["invite Jo"], rationale: "Tariq explicitly asked for the invitation." },
        { id: "dietary", anyOf: ["send.*dietary", "dietary.*Wednesday"], rationale: "Tariq explicitly asked for the numbers." }
      ],
      forbiddenActionItems: [
        { id: "venue-task", anyOf: ["(?:book|confirm|find).*North Hall"], rationale: "The venue is already confirmed." }
      ],
      replyBeats: [
        { id: "reply-budget", anyOf: ["budget"], rationale: "A complete reply addresses the overdue promise." },
        { id: "reply-jo", anyOf: ["Jo"], rationale: "A complete reply addresses the invitation." },
        { id: "reply-dietary", anyOf: ["dietary", "numbers"], rationale: "A complete reply addresses the deadline." },
        { id: "reply-driving", anyOf: ["driving", "congrat", "amazing"], rationale: "A thoughtful reply acknowledges the news." }
      ],
      identityForbidden: [],
      voicePreferredAnyOf: ["amazing", "will do"],
      voiceAvoided: [],
      minimumReplies: 3
    },
    rubric: [
      "Recall all three live actions separately.",
      "Treat North Hall as resolved context.",
      "Acknowledge the driving-test news without replacing an action item."
    ]
  },
  {
    id: "ambiguous-outcome",
    title: "Ambiguous update whose outcome is not yet known",
    tags: ["ambiguous", "short_conversation", "new_replies"],
    platform: "IMESSAGE",
    displayName: "Ishan",
    previousOpenLoops: [],
    messages: [
      { direction: "OUT", text: "How did it go?", timestamp: "2026-07-10T08:00:00.000Z" },
      { direction: "IN", text: "Not sure yet, they said they'll let me know soon", timestamp: "2026-07-10T08:20:00.000Z" }
    ],
    operatorProfile: profile({
      displayName: "Mae",
      about: "Thoughtful but brief. I do not guess when something is unclear.",
      preferredStyle: "thoughtful"
    }),
    expected: {
      state: {
        needsReply: true,
        minRequiredPoints: 0,
        maxRequiredPoints: 1,
        uncertaintyAnyOf: ["not sure", "not (?:known|clear)", "waiting", "let .* know", "uncertain"]
      },
      facts: [
        { id: "unknown-outcome", anyOf: ["not sure", "waiting", "let .* know", "outcome.*(?:unknown|unclear)"], rationale: "The result remains uncertain." }
      ],
      forbiddenFactualClaims: [
        { id: "invented-success", anyOf: ["got (?:it|the job|accepted)", "was accepted", "passed"], rationale: "No successful outcome was stated." },
        { id: "invented-failure", anyOf: ["rejected", "didn['’]?t get", "failed"], rationale: "No negative outcome was stated." },
        { id: "invented-domain", anyOf: ["interview", "exam", "application"], rationale: "The conversation never says what 'it' was." }
      ],
      actionItems: [],
      forbiddenActionItems: [
        { id: "invented-chase", anyOf: ["(?:email|call|chase|contact) them"], rationale: "Nobody asked Mae to chase anyone." }
      ],
      replyBeats: [
        { id: "reply-uncertainty", anyOf: ["hope", "fingers crossed", "let me know", "waiting", "not sure"], rationale: "A useful reply stays with the uncertainty." }
      ],
      identityForbidden: [],
      voicePreferredAnyOf: [],
      voiceAvoided: [],
      minimumReplies: 3
    },
    rubric: [
      "Do not infer whether this was a job, exam or application.",
      "Preserve uncertainty in the summary and suggested replies.",
      "Do not manufacture an action item."
    ]
  },
  {
    id: "emotional-no-advice",
    title: "Emotional disclosure with an explicit no-advice boundary",
    tags: ["emotional", "new_replies", "different_user_voice_rules"],
    platform: "WHATSAPP",
    displayName: "Zara",
    previousOpenLoops: [],
    messages: [
      { direction: "OUT", text: "How are things your side?", timestamp: "2026-07-09T20:00:00.000Z" },
      {
        direction: "IN",
        text: "My dad's back in hospital. I don't really want advice, just wanted to tell you. I might go quiet for a bit.",
        timestamp: "2026-07-10T07:00:00.000Z"
      }
    ],
    operatorProfile: profile({
      displayName: "Amina",
      about: "Warm and gentle. I keep emotional replies simple and never use emoji.",
      commonPhrases: "i'm here\nmate",
      avoidedPhrases: "sending positive vibes",
      preferredStyle: "warm"
    }),
    expected: {
      state: { needsReply: true, minRequiredPoints: 1, maxRequiredPoints: 2 },
      facts: [
        { id: "dad-hospital", anyOf: ["dad['’]?s?.*(?:back )?in hospital", "father.*hospital"], rationale: "The disclosure must be stated accurately." },
        { id: "no-advice", anyOf: ["doesn['’]?t want advice", "no advice", "not.*advice"], rationale: "The boundary is central to a safe response." },
        { id: "may-go-quiet", anyOf: ["go quiet", "might be quiet"], rationale: "The likely interruption must be remembered." }
      ],
      forbiddenFactualClaims: [
        { id: "invented-diagnosis", anyOf: ["cancer", "surgery", "operation", "diagnos"], rationale: "No diagnosis or procedure was named." },
        { id: "invented-certainty", anyOf: ["everything will be (?:fine|okay|ok)", "he['’]?ll be (?:fine|okay|ok)"], rationale: "Reassurance cannot claim an unknown outcome." }
      ],
      actionItems: [
        { id: "acknowledge-without-advice", anyOf: ["acknowledge", "support", "be there", "give .* space", "no advice"], rationale: "The only obligation is a gentle acknowledgement that respects the boundary." }
      ],
      forbiddenActionItems: [
        { id: "give-advice", anyOf: ["(?:offer|give|send).*advice", "suggest.*(?:doctor|treatment)"], rationale: "Zara explicitly declined advice." }
      ],
      replyBeats: [
        { id: "reply-support", anyOf: ["here", "sorry", "thinking of you", "take .* time", "no need to reply"], rationale: "A useful reply offers quiet support." }
      ],
      identityForbidden: [
        { id: "dad-owner-flip", anyOf: ["my dad['’]?s? (?:back )?in hospital", "my father.*hospital"], rationale: "The hospital update belongs to Zara, not Amina." }
      ],
      voicePreferredAnyOf: ["i['’]?m here", "mate"],
      voiceAvoided: ["sending positive vibes"],
      minimumReplies: 3
    },
    rubric: [
      "Respect the explicit no-advice boundary.",
      "Do not predict the father's outcome or invent a diagnosis.",
      "Keep Zara's family circumstances out of Amina's first-person identity.",
      "No emoji because Amina explicitly forbids them."
    ]
  },
  {
    id: "casual-lowercase-no-stops",
    title: "Casual voice requiring lowercase, no full stops and no emoji",
    tags: ["different_user_voice_rules", "strict_punctuation_rules", "short_conversation", "action_items"],
    platform: "IMESSAGE",
    displayName: "Dev",
    previousOpenLoops: [],
    messages: [
      { direction: "OUT", text: "yhh nice", timestamp: "2026-07-10T09:00:00.000Z" },
      {
        direction: "IN",
        text: "got the tickets btw, train gets in at 7, can you meet me by the south exit?",
        timestamp: "2026-07-10T09:15:00.000Z"
      }
    ],
    operatorProfile: profile({
      displayName: "Kai",
      about: "I write all lowercase, keep messages short, never use full stops and never use emoji.",
      commonPhrases: "yhh\nsweet",
      avoidedPhrases: "cheers",
      preferredStyle: "casual"
    }),
    operatorStyle: {
      sampleCount: 8,
      avgWords: 4,
      lengthLabel: "very short",
      emojiPerMessage: 0,
      topEmojis: [],
      fullStopRate: 0,
      lowercaseRate: 1
    },
    expected: {
      state: { needsReply: true, minRequiredPoints: 1, maxRequiredPoints: 2 },
      facts: [
        { id: "train-seven", anyOf: ["train.*(?:at )?7", "7.*train"], rationale: "The arrival time matters." },
        { id: "south-exit", anyOf: ["south exit"], rationale: "The meeting location matters." }
      ],
      forbiddenFactualClaims: [
        { id: "invented-exit", anyOf: ["north exit", "main exit"], rationale: "The message specifies south exit." }
      ],
      actionItems: [
        { id: "meet-south", anyOf: ["(?:meet|confirm).*south exit", "south exit.*(?:meet|confirm)"], rationale: "Kai must answer the meeting request." }
      ],
      forbiddenActionItems: [],
      replyBeats: [
        { id: "reply-meet", anyOf: ["meet", "be there", "see you"], rationale: "A useful reply answers the request." },
        { id: "reply-location", anyOf: ["south exit"], rationale: "A useful reply repeats the exact location." }
      ],
      identityForbidden: [],
      voicePreferredAnyOf: ["yhh", "sweet"],
      voiceAvoided: ["cheers"],
      minimumReplies: 3
    },
    rubric: [
      "Every reply must be lowercase.",
      "Every reply must contain zero full stops and zero emoji.",
      "Keep the exact south-exit location and 7 arrival context.",
      "Do not force Kai's preferred phrases into every variant."
    ]
  },
  {
    id: "formal-source-table-no-exclamation",
    title: "Formal voice with an answered point and one remaining deliverable",
    tags: ["already_answered_points", "different_user_voice_rules", "strict_punctuation_rules", "action_items"],
    platform: "LINKEDIN",
    displayName: "Priya Shah",
    previousOpenLoops: ["Answer Priya's analysis question", "Revise the deck"],
    messages: [
      { direction: "OUT", text: "I've attached the revised deck. Does the analysis answer your question?", timestamp: "2026-07-09T15:00:00.000Z" },
      {
        direction: "IN",
        text: "Thank you, the analysis answers my question. Please send the source table by Monday. No need to revise the deck.",
        timestamp: "2026-07-10T09:45:00.000Z"
      }
    ],
    operatorProfile: profile({
      displayName: "Noor",
      about: "I write concise professional messages. Never use exclamation marks or emoji.",
      commonPhrases: "Thank you\nI will send it over",
      avoidedPhrases: "Hope you're well",
      preferredStyle: "direct"
    }),
    expected: {
      state: { needsReply: true, minRequiredPoints: 1, maxRequiredPoints: 1 },
      facts: [
        { id: "analysis-answered", anyOf: ["analysis answers", "question.*answered", "answered.*question"], rationale: "This previous point is resolved." },
        { id: "source-monday", anyOf: ["source table.*Monday", "Monday.*source table"], rationale: "This is the only remaining deliverable." },
        { id: "no-revision", anyOf: ["no need to revise", "deck.*(?:doesn['’]?t|does not).*need.*revis"], rationale: "The revision loop is explicitly closed." }
      ],
      forbiddenFactualClaims: [],
      actionItems: [
        { id: "send-source", anyOf: ["send.*source table", "source table.*Monday"], rationale: "Priya explicitly requested the table." }
      ],
      forbiddenActionItems: [
        { id: "revise-deck", anyOf: ["revise.*deck", "deck.*revis"], rationale: "Priya explicitly said no revision is needed." },
        { id: "answer-question", anyOf: ["answer.*(?:analysis )?question"], rationale: "Priya said the analysis already answered it." }
      ],
      replyBeats: [
        { id: "reply-source", anyOf: ["source table", "send it over", "Monday"], rationale: "A useful reply confirms the remaining deliverable." }
      ],
      identityForbidden: [
        { id: "request-owner-flip", anyOf: ["I need you to send.*source table"], rationale: "Priya requested the table from Noor, not the reverse." }
      ],
      voicePreferredAnyOf: ["thank you", "send it over"],
      voiceAvoided: ["hope you're well"],
      minimumReplies: 3
    },
    rubric: [
      "Only the source table remains required.",
      "The answered analysis question and deck revision must not reappear as tasks.",
      "Every reply must contain zero exclamation marks and zero emoji.",
      "Use a concise professional register."
    ]
  }
];
