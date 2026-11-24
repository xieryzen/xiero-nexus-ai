"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Sheet } from "@/components/sheet";
import { cn } from "@/components/ui";
import type { PickerGroup, PickerModel } from "@/lib/chat-model-rules";
import { tierLabel } from "@/lib/roles";

/** Up to this many models, the list shows them all at once, under their providers. */
const ALL_AT_ONCE_UP_TO = 8;

/**
 * The model of a conversation: "Auto" (the app chooses, and asks the next
 * model when one does not answer), or one of the models the account is
 * offered. The button names the one in use; pressed, it opens the list: the
 * categories are the providers, and in each the highest and newest model
 * comes first. A model above the account's role is shown with the role it
 * takes, and cannot be chosen.
 */
export function ModelPicker({
  groups,
  value,
  onChange,
  disabled = false,
}: {
  groups: PickerGroup[];
  /** The id of the chosen model; "" is Auto. */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** The provider whose models are shown; null is the first list. */
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.models.length, 0), [groups]);
  const chosen = useMemo(() => {
    for (const group of groups) {
      const model = group.models.find((m) => m.id === value);
      if (model) return { model, group };
    }
    return null;
  }, [groups, value]);
  const allAtOnce = total <= ALL_AT_ONCE_UP_TO;
  const gated = useMemo(() => groups.some((group) => group.models.some((m) => m.minTier !== "free")), [groups]);
  const opened = category ? (groups.find((group) => group.id === category) ?? null) : null;

  const needle = query.trim().toLowerCase();
  const found = useMemo(
    () =>
      needle
        ? groups.flatMap((group) =>
            (group.name.toLowerCase().includes(needle) ? group.models : group.models.filter((m) => m.name.toLowerCase().includes(needle))).map((model) => ({ model, group })),
          )
        : [],
    [groups, needle],
  );

  function show() {
    setQuery("");
    setCategory(null);
    setOpen(true);
  }

  function choose(id: string) {
    onChange(id);
    setOpen(false);
  }

  const label = chosen ? chosen.model.name : "Auto";

  const row = (model: PickerModel, under?: string) => (
    <button
      key={model.id}
      type="button"
      role="option"
      aria-selected={value === model.id}
      aria-disabled={model.locked}
      data-model-id={model.id}
      data-model-name={model.name}
      data-locked={model.locked ? "true" : undefined}
      title={model.locked ? `For ${tierLabel(model.minTier)} and above` : model.name}
      onClick={() => {
        if (!model.locked) choose(model.id);
      }}
      className={cn("list-row", model.locked && "cursor-not-allowed")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("break-words text-[16px]", model.locked ? "text-ink-3" : "text-ink")}>{model.name}</span>
          {model.minTier !== "free" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink/[0.08] px-2 py-0.5 text-[11px] font-medium text-ink-2">
              {model.locked && <Icon name="lock" size={11} />}
              {model.locked ? `Needs ${tierLabel(model.minTier)}` : tierLabel(model.minTier)}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">
          {under ? `${under} · ` : ""}
          {model.tools ? "Works with tools: it can act" : "Not marked for tools: it may only answer"}
        </span>
      </span>
      {value === model.id && <Icon name="check" size={21} className="shrink-0 text-accent-ink" />}
    </button>
  );

  return (
    <>
      <button
        type="button"
        onClick={show}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        title={chosen ? `${chosen.model.name} · ${chosen.group.name}` : "The app chooses the model"}
        data-testid="model-picker"
        data-model={value}
        className="flex h-10 min-w-0 max-w-[12rem] items-center gap-1 rounded-full bg-surface-2 pl-3.5 pr-2.5 text-[15px] text-ink transition hover:bg-surface-3 disabled:opacity-50 sm:max-w-[16rem]"
      >
        <span className="truncate">{label}</span>
        <Icon name="chevron" size={15} className="shrink-0 text-ink-3" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} onBack={opened ? () => setCategory(null) : undefined} title={opened ? opened.name : "Model"}>
        <div role="listbox" aria-label="Models" data-testid="model-list" className="pb-4">
          {opened ? (
            <section data-category={opened.name}>
              <div className="list-group">{opened.models.map((model) => row(model))}</div>
            </section>
          ) : (
            <>
              {!allAtOnce && (
                <label className="mb-3 flex items-center gap-2.5 rounded-2xl border border-line-strong bg-field px-3.5 py-2.5 text-ink-3">
                  <Icon name="search" size={18} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models"
                    aria-label="Search models"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-3 focus:outline-none"
                  />
                </label>
              )}
              {needle ? (
                found.length > 0 ? (
                  <div className="list-group">{found.map(({ model, group }) => row(model, group.name))}</div>
                ) : (
                  <p className="px-2 py-8 text-center text-[15px] text-ink-3">No model is called that.</p>
                )
              ) : (
                <>
                  <div className="list-group">
                    <button type="button" role="option" aria-selected={value === ""} data-model-id="" data-model-name="Auto" onClick={() => choose("")} className="list-row">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[16px] text-ink">Auto</span>
                        <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">The app chooses, and asks the next one when one does not answer</span>
                      </span>
                      {value === "" && <Icon name="check" size={21} className="shrink-0 text-accent-ink" />}
                    </button>
                    {!allAtOnce && chosen && row(chosen.model, chosen.group.name)}
                  </div>
                  {allAtOnce ? (
                    groups.map((group) => (
                      <section key={group.id} data-category={group.name} className="mt-4">
                        <p className="list-title">{group.name}</p>
                        <div className="list-group">{group.models.map((model) => row(model))}</div>
                      </section>
                    ))
                  ) : (
                    <div className="mt-4">
                      <p className="list-title">Providers</p>
                      <div className="list-group">
                        {groups.map((group) => (
                          <button key={group.id} type="button" data-category={group.name} onClick={() => setCategory(group.id)} className="list-row">
                            <span className="min-w-0 flex-1 truncate text-[16px]">{group.name}</span>
                            <span className="shrink-0 text-[15px] tabular-nums text-ink-3">{group.models.length}</span>
                            <Icon name="right" size={18} className="shrink-0 text-ink-3" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {gated && (
            <p className="px-4 pt-3 text-[13px] leading-snug text-ink-3">
              A model that names a plan is part of that plan and of the ones above it.{" "}
              <Link href="/dashboard/plans" className="text-accent-ink underline underline-offset-2">
                See the plans
              </Link>
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}
