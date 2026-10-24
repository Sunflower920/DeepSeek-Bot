// Tool policies: what a Bot or a group is allowed to reach for, declared.
//
// Which tools a Bot may use used to be implied - nothing declared it, so
// nothing could be wrong, and a Bot that should not have been sending files
// into the group was only ever stopped by luck or by a refusal buried in one
// tool. A policy names the set, a Bot or a group names the policy, and an
// unknown name is an error at the moment it is set: a policy nobody declared
// must fail loudly, because silently falling back to "everything" is how a
// restriction becomes decoration.
export const POLICY_ALL = 'all'

export const policyError = (id, declared) => `No tool policy named "${id}"; declared: ${declared.length > 0 ? declared.join(', ') : 'none yet'}. Declare it first.`

export function install(rt) {
  const { state } = rt

  const declared = () => Object.keys(state.toolPolicies ?? {})
  const policyOf = id => state.toolPolicies?.[id]
  const isDeclared = id => id === POLICY_ALL || policyOf(id) !== undefined

  // What a Bot or a group may reach for. A group's policy is narrower than the
  // Bot's when both are set: the room decides what happens in it.
  const toolsFor = ({ botId, roomId } = {}) => {
    const bot = rt.botOf(botId)?.toolPolicy
    const room = rt.roomOf(roomId)?.toolPolicy
    for (const id of [room, bot]) {
      if (id === undefined || !isDeclared(id)) continue
      if (id === POLICY_ALL) continue
      const tools = policyOf(id)?.tools ?? []
      return { id, tools }
    }
    return { id: POLICY_ALL, tools: [] }
  }

  // The gate every ds-bot tool passes: an empty set means everything, and
  // anything else is a whitelist.
  const allowsTool = (name, scope) => {
    const { id, tools } = toolsFor(scope)
    if (id === POLICY_ALL || tools.length === 0) return true
    return tools.includes(name)
  }
  const refusalFor = (name, scope) => {
    const { id, tools } = toolsFor(scope)
    return `"${name}" is not in the "${id}" policy this works under (${tools.join(', ') || 'nothing'}). Ask a Main Bot to widen the policy.`
  }

  Object.assign(rt, { declaredPolicies: declared, policyOf, isDeclaredPolicy: isDeclared, toolsFor, allowsTool, refusalFor })
}
