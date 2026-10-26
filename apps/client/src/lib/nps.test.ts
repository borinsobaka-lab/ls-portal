import { describe, expect, test } from "bun:test";
import {
  NPS_FOLLOW_UP,
  commentAfterScoreChange,
  npsFormError,
  npsGroup,
  npsSurveyTexts,
  parseNpsSurvey,
} from "./nps";

describe("npsGroup", () => {
  test("0–6 критик, 7–8 нейтрал, 9–10 промоутер", () => {
    expect([0, 6].map(npsGroup)).toEqual(["detractor", "detractor"]);
    expect([7, 8].map(npsGroup)).toEqual(["passive", "passive"]);
    expect([9, 10].map(npsGroup)).toEqual(["promoter", "promoter"]);
  });

  test("уточняющий вопрос — по группе", () => {
    expect(NPS_FOLLOW_UP[npsGroup(3)]).toBe("Что именно вас расстроило? Расскажите подробнее.");
    expect(NPS_FOLLOW_UP[npsGroup(8)]).toBe("Чего не хватает, чтобы вы поставили нам 10?");
    expect(NPS_FOLLOW_UP[npsGroup(10)]).toBe("Что вам нравится больше всего?");
  });
});

describe("npsFormError", () => {
  test("без оценки, без ответа, всё заполнено", () => {
    expect(npsFormError(null, "Тренеры")).toBe("Пожалуйста, выберите оценку.");
    expect(npsFormError(0, "   ")).toBe("Пожалуйста, ответьте на вопрос выше.");
    expect(npsFormError(0, "Мало места")).toBeNull();
  });
});

describe("commentAfterScoreChange", () => {
  test("вопрос сменился — комментарий стирается, тот же вопрос — остаётся", () => {
    expect(commentAfterScoreChange(null, 9, "")).toBe("");
    expect(commentAfterScoreChange(9, 10, "Тренеры")).toBe("Тренеры");
    expect(commentAfterScoreChange(8, 9, "Тренеры")).toBe("");
    expect(commentAfterScoreChange(6, 0, "Душ")).toBe("Душ");
  });
});

describe("parseNpsSurvey", () => {
  test("ответ RPC → опрос или null", () => {
    expect(parseNpsSurvey({ survey_type: "first_month", occasion: "once" })).toEqual({
      survey_type: "first_month",
      occasion: "once",
    });
    expect(parseNpsSurvey(null)).toBeNull();
    expect(parseNpsSurvey({ survey_type: "general", occasion: "once" })).toBeNull();
    expect(parseNpsSurvey({ survey_type: "after_return", occasion: "" })).toBeNull();
  });
});

describe("npsSurveyTexts", () => {
  test("перед продлением — студия или клуб по формату приложения", () => {
    expect(npsSurveyTexts("before_renewal", true).description).toEndWith("улучшать студию.");
    expect(npsSurveyTexts("before_renewal", false).description).toEndWith("улучшать клуб.");
    expect(npsSurveyTexts("first_lessons", true).description).toContain("{brand}");
  });
});
