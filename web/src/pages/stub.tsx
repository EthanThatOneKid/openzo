import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CircleCheck, CircleDashed, CircleMinus } from "lucide-react";
import { api, type Feature } from "@/lib/api";
import { PageHeader } from "@/components/shell";

const ICON = { working: CircleCheck, partial: CircleDashed, stub: CircleMinus };
const TONE = { working: "text-emerald-600", partial: "text-amber-600", stub: "text-muted-foreground" };

export default function StubPage() {
  const { feature } = useParams();
  const [features, setFeatures] = useState<Feature[]>([]);
  useEffect(() => {
    void api<{ features: Feature[] }>("/api/features").then((d) => setFeatures(d.features));
  }, []);
  const f = features.find((x) => x.id === feature);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={f?.name ?? "Not available"} description="This part of hosted Zo isn't part of openzo." />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-2xl">
          {f && (
            <div className="rounded-xl border bg-card p-5 shadow-xs">
              <p className="text-sm leading-relaxed">{f.detail}</p>
              <p className="mt-4 text-sm text-muted-foreground">
                The agent can often do the job another way — <Link to="/" className="underline underline-offset-2">ask it</Link>.
              </p>
            </div>
          )}
          <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">Everything a hosted Zo has, and where openzo stands</h2>
          <div className="overflow-hidden rounded-xl border bg-card">
            {features.map((x) => {
              const Icon = ICON[x.status];
              return (
                <div key={x.id} className="flex gap-3 border-b px-4 py-3 last:border-b-0">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${TONE[x.status]}`} />
                  <div>
                    <div className="text-sm font-medium">
                      {x.name} <span className={`ml-1 text-xs font-normal ${TONE[x.status]}`}>{x.status === "stub" ? "not available" : x.status}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{x.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
