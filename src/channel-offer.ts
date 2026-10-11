// A reply may only invite write actions whose preparing tool this session actually has.
// Detection is per clause: an agent-side marker ("帮您", "为您", "我可以"...) directly before a
// write verb, the action's object after the verb in the same clause, and no negation before it.
// It covers observed offer phrasings, not every paraphrase.
const clauseBreak = /[，,、。！？!?；;：:\n]/u;
const offer = /(?:(?:帮|为|替|代)(?:您|你)[^，,、。！？!?；;：:\n]{0,4}?|我(?:来|可以|能|可|再|会|将|就|也|马上|立即|这就|现在)*)(发起|提交|申请|办理|准备|生成|联系|创建|安排|处理|转交)/gu;
const negation = /[未没不无非别]/u;
const reference = "(?!规则|说明|流程|政策|条件|进度|记录|信息|状态|资格|金额)";
const actions = [
  { tool: "prepare_merchant_request", object: new RegExp(`(?:协商|商家)${reference}`, "u") },
  { tool: "prepare_refund", object: new RegExp(`(?:退款|退钱|退费)${reference}`, "u") },
];

export function offersUnavailableAction(text: string, activeToolNames: readonly string[]): boolean {
  return text.split(clauseBreak).some(clause => [...clause.matchAll(offer)].some(match => {
    const verbStart = match.index + match[0].length - match[1]!.length;
    if (negation.test(clause.slice(0, verbStart))) return false;
    const rest = clause.slice(verbStart);
    return actions.some(action => action.object.test(rest) && !activeToolNames.includes(action.tool));
  }));
}

// Streams only whole clauses that passed the same check; after a failing clause nothing more is sent.
export function createOfferStreamGate(activeToolNames: readonly string[]) {
  let text = "", sent = 0, blocked = false;
  const release = (end: number) => {
    if (blocked || end <= sent) return "";
    if (offersUnavailableAction(text.slice(0, end), activeToolNames)) { blocked = true; return ""; }
    const chunk = text.slice(sent, end); sent = end; return chunk;
  };
  return {
    push(delta: string) {
      text += delta;
      for (let index = text.length - 1; index >= sent; index--) if (clauseBreak.test(text[index]!)) return release(index + 1);
      return "";
    },
    end: () => release(text.length),
  };
}
