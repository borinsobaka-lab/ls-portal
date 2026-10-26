import { useEffect, useRef, useState } from "react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachInstruction,
  extractInstruction,
  type Instruction,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/list-item";

export type RowDropOperation = Instruction["operation"];

/**
 * Строка, которую перетаскивают на место другой строки того же списка
 * (базы знаний, папки и статьи в дереве). Куда встанет — видно сразу:
 * линия над или под строкой («reorder-before» / «reorder-after»), а у папки —
 * подсветка «внутрь» («combine»). Библиотека — pragmatic-drag-and-drop:
 * зона строки делится по высоте, поэтому попадание не зависит от того,
 * задели ли курсором край — в Платруме перенос срабатывал «с третьего раза».
 *
 * `type` — у каждого списка свой: строку одного списка в другой не уронить.
 * `onDrop(sourceId, operation)` — зовётся у строки, на которую уронили.
 */
export function useDragRow<T extends HTMLElement, H extends HTMLElement = HTMLElement>({
  id,
  type,
  disabled,
  canCombine,
  canDrop,
  onDrop,
}: {
  id: string;
  type: string;
  disabled?: boolean;
  /** Можно ли уронить внутрь (папка). */
  canCombine?: boolean;
  /** Можно ли уронить сюда эту строку (папку внутрь самой себя — нельзя). */
  canDrop?: (sourceId: string) => boolean;
  onDrop: (sourceId: string, operation: RowDropOperation) => void;
}) {
  const ref = useRef<T | null>(null);
  const handleRef = useRef<H | null>(null);
  const [dragging, setDragging] = useState(false);
  const [instruction, setInstruction] = useState<Instruction | null>(null);
  // Обработчики меняются на каждой отрисовке — подписку держим одну.
  const latest = useRef({ canDrop, onDrop, canCombine });
  latest.current = { canDrop, onDrop, canCombine };

  useEffect(() => {
    const element = ref.current;
    if (!element || disabled) return;
    return combine(
      draggable({
        element,
        dragHandle: handleRef.current ?? undefined,
        getInitialData: () => ({ type, id }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          source.data.type === type &&
          source.data.id !== id &&
          (latest.current.canDrop?.(source.data.id as string) ?? true),
        getData: ({ input, element: el }) =>
          attachInstruction(
            { id },
            {
              input,
              element: el,
              operations: {
                "reorder-before": "available",
                "reorder-after": "available",
                combine: latest.current.canCombine ? "available" : "not-available",
              },
            },
          ),
        onDrag: ({ self }) => setInstruction(extractInstruction(self.data)),
        onDragLeave: () => setInstruction(null),
        onDrop: ({ self, source }) => {
          setInstruction(null);
          const ins = extractInstruction(self.data);
          if (ins && !ins.blocked) latest.current.onDrop(source.data.id as string, ins.operation);
        },
      }),
    );
  }, [id, type, disabled]);

  return { ref, handleRef, dragging, instruction };
}
