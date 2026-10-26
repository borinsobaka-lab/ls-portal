import { describe, expect, test } from "bun:test";

import {
  pickTrainer,
  regularTrainerIds,
  removeTrainer,
  substitutionsOf,
  trainerChanges,
  undoSubstitution,
  type TrainerAssignment,
} from "./schedule-trainers";

const names: Record<string, string> = { anna: "Анна", olga: "Ольга", ira: "Ира", vera: "Вера" };
const nameOf = (id: string) => names[id] ?? null;
const state = (ids: string[], subs: TrainerAssignment["subs"] = {}): TrainerAssignment => ({
  ids,
  subs,
});

describe("замены из ответа базы", () => {
  const links = [
    {
      trainer_id: "olga",
      substitution: { replaced_trainer_id: "anna", replaced: { full_name: "Анна" } },
    },
    { trainer_id: "ira", substitution: [] },
    { trainer_id: "vera", substitution: null },
  ];

  test("связь 1:1 приходит объектом или массивом — обе формы", () => {
    expect(substitutionsOf(links)).toEqual({ olga: { id: "anna", name: "Анна" } });
    expect(
      substitutionsOf([
        { trainer_id: "olga", substitution: [{ replaced_trainer_id: "anna", replaced: null }] },
      ]),
    ).toEqual({ olga: { id: "anna", name: null } });
    expect(substitutionsOf(undefined)).toEqual({});
  });

  test("копия занятия берёт того, кого заменили, без повторов", () => {
    expect(regularTrainerIds(links)).toEqual(["anna", "ira", "vera"]);
    // Заменили одного тренера другим, который и так стоит на занятии.
    expect(
      regularTrainerIds([
        { trainer_id: "anna" },
        { trainer_id: "olga", substitution: { replaced_trainer_id: "anna", replaced: null } },
      ]),
    ).toEqual(["anna"]);
  });
});

describe("правка тренеров в окне занятия", () => {
  test("замена: новый тренер вместо прежнего, замена помнит прежнего", () => {
    expect(pickTrainer(state(["anna"]), 0, "olga", "replace", nameOf)).toEqual(
      state(["olga"], { olga: { id: "anna", name: "Анна" } }),
    );
  });

  test("замена замены — всё ещё вместо первого тренера", () => {
    const once = pickTrainer(state(["anna"]), 0, "olga", "replace", nameOf);
    expect(pickTrainer(once, 0, "ira", "replace", nameOf)).toEqual(
      state(["ira"], { ira: { id: "anna", name: "Анна" } }),
    );
  });

  test("замена на того, кого заменяли, — замены больше нет", () => {
    const once = pickTrainer(state(["anna"]), 0, "olga", "replace", nameOf);
    expect(pickTrainer(once, 0, "anna", "replace", nameOf)).toEqual(state(["anna"]));
  });

  test("«Редактировать» — другой тренер без замены; у заменяющего замена переходит новому", () => {
    expect(pickTrainer(state(["anna"]), 0, "olga", "edit", nameOf)).toEqual(state(["olga"]));
    const once = pickTrainer(state(["anna"]), 0, "olga", "replace", nameOf);
    expect(pickTrainer(once, 0, "ira", "edit", nameOf)).toEqual(
      state(["ira"], { ira: { id: "anna", name: "Анна" } }),
    );
  });

  test("тот же тренер или уже стоящий на занятии — ничего не меняется", () => {
    const s = state(["anna", "olga"]);
    expect(pickTrainer(s, 0, "anna", "replace", nameOf)).toBe(s);
    expect(pickTrainer(s, 0, "olga", "edit", nameOf)).toBe(s);
    expect(pickTrainer(s, 2, "ira", "add", nameOf)).toEqual(state(["anna", "olga", "ira"]));
    expect(pickTrainer(s, 2, "olga", "add", nameOf)).toBe(s);
  });

  test("другие тренеры и их замены не трогаются", () => {
    const s = state(["olga", "vera"], { olga: { id: "anna", name: "Анна" } });
    expect(pickTrainer(s, 1, "ira", "replace", nameOf)).toEqual(
      state(["olga", "ira"], {
        olga: { id: "anna", name: "Анна" },
        ira: { id: "vera", name: "Вера" },
      }),
    );
  });

  test("«Отменить замену» возвращает прежнего; если он и так на занятии — заменяющий уходит", () => {
    const s = state(["olga", "vera"], { olga: { id: "anna", name: "Анна" } });
    expect(undoSubstitution(s, 0)).toEqual(state(["anna", "vera"]));
    const both = state(["anna", "olga"], { olga: { id: "anna", name: "Анна" } });
    expect(undoSubstitution(both, 1)).toEqual(state(["anna"]));
    expect(undoSubstitution(state(["anna"]), 0)).toEqual(state(["anna"]));
  });

  test("убрать тренера — вместе с его заменой", () => {
    const s = state(["olga", "vera"], { olga: { id: "anna", name: "Анна" } });
    expect(removeTrainer(s, 0)).toEqual(state(["vera"]));
  });
});

describe("что сохранить", () => {
  test("замена тренера: снять прежнего, добавить нового, записать замену", () => {
    const before = state(["anna"]);
    const after = pickTrainer(before, 0, "olga", "replace", nameOf);
    expect(trainerChanges(before, after)).toEqual({
      removed: ["anna"],
      added: ["olga"],
      dropSubs: [],
      putSubs: [{ trainer_id: "olga", replaced_trainer_id: "anna" }],
    });
  });

  test("без правок — ничего; правка времени не трогает тренеров и замены", () => {
    const s = state(["olga", "vera"], { olga: { id: "anna", name: "Анна" } });
    expect(trainerChanges(s, s)).toEqual({ removed: [], added: [], dropSubs: [], putSubs: [] });
  });

  test("отменили замену: заменяющего — снять, прежнего — добавить (замена уйдёт каскадом)", () => {
    const before = state(["olga"], { olga: { id: "anna", name: "Анна" } });
    expect(trainerChanges(before, undoSubstitution(before, 0))).toEqual({
      removed: ["olga"],
      added: ["anna"],
      dropSubs: [],
      putSubs: [],
    });
  });

  test("убрали замену у оставшегося тренера — удалить строку замены", () => {
    const before = state(["anna", "olga"], { olga: { id: "anna", name: "Анна" } });
    // Прежний и так на занятии: отмена убирает заменяющего — снимается он.
    expect(trainerChanges(before, undoSubstitution(before, 1)).removed).toEqual(["olga"]);
    // Замена снята, а тренер остался (снят и снова добавлен в одной правке).
    const kept = state(["olga"]);
    expect(trainerChanges(before, kept)).toEqual({
      removed: ["anna"],
      added: [],
      dropSubs: ["olga"],
      putSubs: [],
    });
  });

  test("замену на занятии с заменой поменяли — записать новую", () => {
    const before = state(["olga"], { olga: { id: "anna", name: "Анна" } });
    const after = state(["olga"], { olga: { id: "vera", name: "Вера" } });
    expect(trainerChanges(before, after).putSubs).toEqual([
      { trainer_id: "olga", replaced_trainer_id: "vera" },
    ]);
  });
});
