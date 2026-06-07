import Database, { type Database as Db } from "better-sqlite3";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Reads contact birthdays from the operator's local macOS Contacts
 * (AddressBook) databases. Opened read-only with better-sqlite3, mirroring
 * platforms/imessage-db.ts: we never write, and a source that cannot be
 * opened (no Contacts data, Full Disk Access not granted) is skipped rather
 * than thrown so one bad database never blocks the rest.
 *
 * macOS keeps one aggregate database plus one per account ("Source"):
 *   ~/Library/Application Support/AddressBook/AddressBook-v22.abcddb
 *   ~/Library/Application Support/AddressBook/Sources/<uuid>/AddressBook-v22.abcddb
 *
 * Contact rows live in ZABCDRECORD; ZBIRTHDAY holds the birthday as a Core
 * Data timestamp (seconds since the 2001-01-01 Apple epoch). Phone numbers
 * and emails hang off ZABCDPHONENUMBER / ZABCDEMAILADDRESS via their ZOWNER
 * column. The birthday-sync service matches those handles to Person rows.
 */

/** Apple Core Data epoch (2001-01-01T00:00:00Z) as a unix-seconds offset. */
const APPLE_EPOCH_OFFSET_SEC = 978_307_200;

export interface AddressBookBirthday {
  /** Best-effort contact name. Diagnostics only; never logged alongside a handle. */
  name: string;
  /** Birthday month/day as zero-padded "MM-DD". */
  monthDay: string;
  /** Four-digit birth year, or null for a year-less contact card. */
  year: number | null;
  /** Raw phone numbers on the card, unnormalized. */
  phones: string[];
  /** Raw email addresses on the card, unnormalized. */
  emails: string[];
}

export interface AddressBookContact {
  /** Real display name (first+last, else nickname, else organization). Never empty. */
  name: string;
  /** Raw phone numbers on the card, unnormalized. */
  phones: string[];
  /** Raw email addresses on the card, unnormalized. */
  emails: string[];
}

/**
 * Convert a ZBIRTHDAY Core Data timestamp into month/day + year. macOS stores
 * birthdays at noon UTC so the calendar day is timezone-stable, so we read the
 * UTC components directly. A year-less card (month + day only) is stored with
 * a sentinel year of 1604; we surface anything before 1900 as `year: null`.
 */
export function appleBirthdayToMonthDay(
  value: number | bigint | null | undefined
): { monthDay: string; year: number | null } | null {
  if (value === null || value === undefined) return null;
  const seconds = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(seconds)) return null;
  const date = new Date((seconds + APPLE_EPOCH_OFFSET_SEC) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const monthDay = `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
  const fullYear = date.getUTCFullYear();
  return { monthDay, year: fullYear < 1900 ? null : fullYear };
}

/**
 * Locate every AddressBook database for the given home directory: the
 * top-level aggregate plus one per account under Sources/. Missing paths are
 * dropped, so the result is safe to hand straight to the reader.
 */
export function findAddressBookDbPaths(home: string = process.env.HOME ?? ""): string[] {
  if (!home) return [];
  const root = join(home, "Library", "Application Support", "AddressBook");
  const paths: string[] = [];
  const aggregate = join(root, "AddressBook-v22.abcddb");
  if (existsSync(aggregate)) paths.push(aggregate);
  const sourcesDir = join(root, "Sources");
  if (existsSync(sourcesDir)) {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(sourcesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(sourcesDir, entry.name, "AddressBook-v22.abcddb");
      if (existsSync(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

/**
 * Best-effort real name for a contact row, or null when the card carries no
 * usable name at all. Returns null (rather than "Unknown contact") so the
 * contact resolver never maps a handle to a placeholder — showing the raw
 * number is strictly more honest than "Unknown contact".
 */
function composeRealName(row: {
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  organization: string | null;
}): string | null {
  const full = [row.firstName, row.lastName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return full || (row.nickname ?? "").trim() || (row.organization ?? "").trim() || null;
}

function composeName(row: {
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  organization: string | null;
}): string {
  return composeRealName(row) ?? "Unknown contact";
}

/**
 * Wraps one AddressBook .abcddb file. Opened read-only; the caller handles
 * EACCES (Full Disk Access / Contacts permission not granted) and ENOENT.
 */
export class AddressBookDb {
  private db: Db;

  constructor(private readonly dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Smoke test: confirm this really is a contacts database before use.
    this.db.prepare("SELECT 1 FROM ZABCDRECORD LIMIT 1").get();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  /** Every contact row in this database that has a birthday set. */
  listBirthdays(): AddressBookBirthday[] {
    const records = this.db
      .prepare(
        `SELECT Z_PK          AS pk,
                ZBIRTHDAY     AS birthday,
                ZFIRSTNAME    AS firstName,
                ZLASTNAME     AS lastName,
                ZNICKNAME     AS nickname,
                ZORGANIZATION AS organization
           FROM ZABCDRECORD
          WHERE ZBIRTHDAY IS NOT NULL`
      )
      .all() as Array<{
        pk: number;
        birthday: number | bigint | null;
        firstName: string | null;
        lastName: string | null;
        nickname: string | null;
        organization: string | null;
      }>;
    if (records.length === 0) return [];

    const pks = records.map((r) => r.pk);
    const phonesByOwner = this.fetchValuesByOwner("ZABCDPHONENUMBER", "ZFULLNUMBER", pks);
    const emailsByOwner = this.fetchValuesByOwner("ZABCDEMAILADDRESS", "ZADDRESS", pks);

    const out: AddressBookBirthday[] = [];
    for (const record of records) {
      const parsed = appleBirthdayToMonthDay(record.birthday);
      if (!parsed) continue;
      out.push({
        name: composeName(record),
        monthDay: parsed.monthDay,
        year: parsed.year,
        phones: phonesByOwner.get(record.pk) ?? [],
        emails: emailsByOwner.get(record.pk) ?? []
      });
    }
    return out;
  }

  /**
   * Every named contact row in this database that has at least one phone or
   * email handle. Powers the iMessage contact resolver: chat.db only stores
   * the raw handle, so we map each handle back to a real name read straight
   * from the operator's macOS Contacts — no manual vCard export required.
   * Nameless cards and cards with no handle are dropped (nothing to resolve).
   */
  listContacts(): AddressBookContact[] {
    const records = this.db
      .prepare(
        `SELECT Z_PK          AS pk,
                ZFIRSTNAME    AS firstName,
                ZLASTNAME     AS lastName,
                ZNICKNAME     AS nickname,
                ZORGANIZATION AS organization
           FROM ZABCDRECORD
          WHERE ZFIRSTNAME IS NOT NULL
             OR ZLASTNAME IS NOT NULL
             OR ZNICKNAME IS NOT NULL
             OR ZORGANIZATION IS NOT NULL`
      )
      .all() as Array<{
        pk: number;
        firstName: string | null;
        lastName: string | null;
        nickname: string | null;
        organization: string | null;
      }>;
    if (records.length === 0) return [];

    const pks = records.map((r) => r.pk);
    const phonesByOwner = this.fetchValuesByOwner("ZABCDPHONENUMBER", "ZFULLNUMBER", pks);
    const emailsByOwner = this.fetchValuesByOwner("ZABCDEMAILADDRESS", "ZADDRESS", pks);

    const out: AddressBookContact[] = [];
    for (const record of records) {
      const name = composeRealName(record);
      if (!name) continue;
      const phones = phonesByOwner.get(record.pk) ?? [];
      const emails = emailsByOwner.get(record.pk) ?? [];
      // A contact with no phone and no email can't be matched to a chat.db
      // handle, so it would only bloat the resolver — drop it.
      if (phones.length === 0 && emails.length === 0) continue;
      out.push({ name, phones, emails });
    }
    return out;
  }

  /**
   * Collect a single string column (phone number / email) for the given
   * owner record PKs, grouped by owner. `table` and `column` are fixed
   * internal constants, never caller input, so the interpolation is safe.
   *
   * Chunked: a full contacts read can pass thousands of owner PKs, which
   * would blow past SQLite's bound-variable ceiling in a single IN(...).
   */
  private fetchValuesByOwner(
    table: "ZABCDPHONENUMBER" | "ZABCDEMAILADDRESS",
    column: "ZFULLNUMBER" | "ZADDRESS",
    ownerPks: number[]
  ): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (ownerPks.length === 0) return map;
    const CHUNK = 500;
    for (let start = 0; start < ownerPks.length; start += CHUNK) {
      const chunk = ownerPks.slice(start, start + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT ZOWNER AS owner, ${column} AS value
             FROM ${table}
            WHERE ZOWNER IN (${placeholders}) AND ${column} IS NOT NULL`
        )
        .all(...chunk) as Array<{ owner: number; value: string | null }>;
      for (const row of rows) {
        const value = (row.value ?? "").trim();
        if (!value) continue;
        const list = map.get(row.owner) ?? [];
        list.push(value);
        map.set(row.owner, list);
      }
    }
    return map;
  }
}

/**
 * Open every AddressBook database for the current user and return all
 * birthdays merged. A database that fails to open (empty source, permission
 * denied) is skipped so one bad source never blocks the rest. Phones and
 * emails come back raw; the birthday-sync service normalizes them to match
 * Person handles.
 */
export function readAllAddressBookBirthdays(dbPaths?: string[]): AddressBookBirthday[] {
  const paths = dbPaths && dbPaths.length > 0 ? dbPaths : findAddressBookDbPaths();
  const all: AddressBookBirthday[] = [];
  for (const path of paths) {
    let db: AddressBookDb | null = null;
    try {
      db = new AddressBookDb(path);
      all.push(...db.listBirthdays());
    } catch {
      // Unreadable or non-contacts database; skip.
    } finally {
      db?.close();
    }
  }
  return all;
}

/**
 * Open every AddressBook database for the current user and return all named
 * contacts (name + phones + emails) merged. Mirrors
 * readAllAddressBookBirthdays: a database that fails to open (empty source,
 * Full Disk Access not granted) is skipped so one bad source never blocks the
 * rest. Phones and emails come back raw; the contact resolver normalizes them
 * to match chat.db handles.
 */
export function readAllAddressBookContacts(dbPaths?: string[]): AddressBookContact[] {
  const paths = dbPaths && dbPaths.length > 0 ? dbPaths : findAddressBookDbPaths();
  const all: AddressBookContact[] = [];
  for (const path of paths) {
    let db: AddressBookDb | null = null;
    try {
      db = new AddressBookDb(path);
      all.push(...db.listContacts());
    } catch {
      // Unreadable or non-contacts database; skip.
    } finally {
      db?.close();
    }
  }
  return all;
}
