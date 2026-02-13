"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { formatRelative } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

interface PersonRow {
  id: string;
  name: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  notes?: string | null;
  tags: string[];
  lastInteractionAt?: string;
  risk: "GREEN" | "AMBER" | "RED";
}

function riskTone(level: string): "green" | "amber" | "red" {
  if (level === "RED") {
    return "red";
  }
  if (level === "AMBER") {
    return "amber";
  }
  return "green";
}

export default function PeoplePage() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<PersonRow[]>("/runner/data/people").then((data) => {
      setPeople(data);
      setSelectedId(data[0]?.id ?? null);
    });
  }, []);

  const selected = useMemo(() => people.find((person) => person.id === selectedId) ?? null, [people, selectedId]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">People</h2>
        <p className="text-sm text-slate-500">Lightweight relationship context across our conversations.</p>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-12 lg:col-span-7">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] border-b border-slate-200 pb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            <span>Name</span>
            <span>Platform</span>
            <span>Last interaction</span>
            <span>Risk</span>
          </div>

          <div className="mt-2 space-y-2">
            {people.map((person) => (
              <button
                key={person.id}
                className={`grid w-full grid-cols-[2fr_1fr_1fr_1fr] rounded-lg border px-3 py-2 text-left text-sm ${selectedId === person.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                onClick={() => setSelectedId(person.id)}
              >
                <span className="font-medium text-slate-900">{person.name}</span>
                <span>
                  <Badge tone="blue">{person.platform}</Badge>
                </span>
                <span className="text-slate-600">{formatRelative(person.lastInteractionAt)}</span>
                <span>
                  <Badge tone={riskTone(person.risk)}>{person.risk}</Badge>
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="col-span-12 space-y-3 lg:col-span-5">
          {selected ? (
            <>
              <h3 className="text-lg font-semibold">{selected.name}</h3>
              <div className="flex items-center gap-2">
                <Badge tone="blue">{selected.platform}</Badge>
                <Badge tone={riskTone(selected.risk)}>{selected.risk}</Badge>
              </div>
              <p className="text-sm text-slate-600">Last interaction {formatRelative(selected.lastInteractionAt)}</p>

              <Card className="bg-slate-50">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Relationship context</h4>
                <p className="mt-2 text-sm text-slate-700">
                  Trusted contact in our network. Conversation cadence is steady, and clarity on next actions keeps this relationship healthy.
                </p>
              </Card>

              <Card className="bg-slate-50">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Tags</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(selected.tags.length ? selected.tags : ["Warm lead"]).map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              </Card>

              <Card className="bg-slate-50">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Notes</h4>
                <Textarea rows={6} defaultValue={selected.notes ?? ""} placeholder="Internal relationship notes..." />
              </Card>

              <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                Manual merge duplicates
              </button>
            </>
          ) : (
            <p className="text-sm text-slate-500">No people yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
