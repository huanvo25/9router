"use client";

import { useState, useEffect, useMemo } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import ModelSelectModal from "./ModelSelectModal";

function ModelItem({ id, index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

/**
 * Reusable model list editor with drag-to-reorder, inline edit, move up/down, remove,
 * and an "Add Model" button that opens ModelSelectModal.
 * Used by the combos page and the endpoint (API key) page for consistent UI.
 */
export default function ModelListEditor({
  models = [],
  onChange,
  activeProviders = [],
  modelAliases = {},
  title = "Add Model",
  kindFilter = null,
  addButtonLabel = "Add Model",
  emptyHint = "No models added yet",
  enableModelTesting = false,
  listClassName = "flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]",
  emptyClassName = "text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]",
  emptyClickable = false,
}) {
  const [showModelSelect, setShowModelSelect] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const modelItems = useMemo(
    () => models.map((model, i) => ({ uid: `item-${i}`, model })),
    [models]
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        onChange(arrayMove(models, oldIndex, newIndex));
      }
    }
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) onChange([...models, model.value]);
  };
  const handleDeselectModel = (model) => {
    onChange(models.filter((m) => m !== model.value));
  };
  const handleRemoveModel = (index) => {
    onChange(models.filter((_, i) => i !== index));
  };
  const handleMoveUp = (index) => {
    if (index === 0) return;
    const next = [...models];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange(next);
  };
  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const next = [...models];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange(next);
  };

  return (
    <>
      {models.length === 0 ? (
        emptyClickable ? (
          <button
            type="button"
            onClick={() => setShowModelSelect(true)}
            className={emptyClassName}
          >
            <span className="material-symbols-outlined text-text-muted text-[34px] mb-2">layers</span>
            <p className="text-sm font-medium text-text-main">{emptyHint}</p>
            <p className="mt-1 text-xs text-text-muted">{addButtonLabel}</p>
          </button>
        ) : (
          <div className={emptyClassName}>
            <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
            <p className="text-xs text-text-muted">{emptyHint}</p>
          </div>
        )
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
          <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
            <div className={listClassName}>
              {modelItems.map(({ uid, model }, index) => (
                <ModelItem
                  key={uid}
                  id={uid}
                  index={index}
                  model={model}
                  isFirst={index === 0}
                  isLast={index === modelItems.length - 1}
                  onEdit={(newVal) => {
                    const updated = [...models];
                    updated[index] = newVal;
                    onChange(updated);
                  }}
                  onMoveUp={() => handleMoveUp(index)}
                  onMoveDown={() => handleMoveDown(index)}
                  onRemove={() => handleRemoveModel(index)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <button
        onClick={() => setShowModelSelect(true)}
        className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
        {addButtonLabel}
      </button>

      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel}
        onDeselect={handleDeselectModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={title}
        kindFilter={kindFilter}
        addedModelValues={models}
        closeOnSelect={false}
        enableModelTesting={enableModelTesting}
      />
    </>
  );
}
