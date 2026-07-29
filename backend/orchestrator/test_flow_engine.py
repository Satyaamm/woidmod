"""Executable proof the FlowEngine runs a flow. Run from the orchestrator dir:

    .venv/bin/python test_flow_engine.py

No pytest dependency — plain asserts so it runs anywhere the package imports.
"""

from src.flow_engine import FlowSpec, FlowEngine, safe_eval

# A real branching flow:
#   start → greet(say) → collect(orderId) → check(condition: vip when amount>100)
#     vip branch     → offer(say) → end
#     default branch → end2
SPEC = {
    "version": 1,
    "entryNodeId": "start",
    "nodes": [
        {"id": "start", "type": "start", "position": {"x": 0, "y": 0}, "data": {}},
        {"id": "greet", "type": "say", "position": {"x": 0, "y": 1}, "data": {"prompt": "Greet the caller"}},
        {"id": "collect", "type": "collect", "position": {"x": 0, "y": 2}, "data": {"slot": "orderId", "prompt": "Ask for the order id"}},
        {"id": "check", "type": "condition", "position": {"x": 0, "y": 3}, "data": {
            "branches": [{"id": "vip", "label": "VIP", "when": "amount > 100 && country == \"US\""}],
            "hasDefault": True,
        }},
        {"id": "offer", "type": "say", "position": {"x": 0, "y": 4}, "data": {"prompt": "Offer a VIP upgrade"}},
        {"id": "end", "type": "end", "position": {"x": 0, "y": 5}, "data": {}},
        {"id": "end2", "type": "end", "position": {"x": 1, "y": 5}, "data": {}},
    ],
    "edges": [
        {"id": "e1", "source": "start", "target": "greet"},
        {"id": "e2", "source": "greet", "target": "collect"},
        {"id": "e3", "source": "collect", "target": "check", "sourceHandle": "filled"},
        {"id": "e4", "source": "check", "target": "offer", "sourceHandle": "vip"},
        {"id": "e5", "source": "check", "target": "end2", "sourceHandle": "default"},
        {"id": "e6", "source": "offer", "target": "end"},
    ],
}


def run_path(amount, country):
    """Drive the engine as the agent loop would, returning the node path taken."""
    engine = FlowEngine(FlowSpec.from_dict(SPEC), base_prompt="You are a support agent.")
    path = []

    step = engine.begin()  # start is a no-op; lands on greet
    path.append(step.node.id)
    assert step.instruction and "Greet the caller" in step.instruction
    assert step.expects_reply is True

    step = engine.advance()  # greet → collect
    path.append(step.node.id)
    assert step.node.type == "collect"
    assert "orderId" in step.instruction

    # Caller supplies the slot; loop records it and advances on 'filled'.
    engine.set_variable("orderId", "A-123")
    engine.set_variable("amount", amount)
    engine.set_variable("country", country)
    step = engine.advance("filled")  # collect → check (condition)
    path.append(step.node.id)
    assert step.node.type == "condition"

    handle = engine.route_condition()
    step = engine.advance(handle)  # branch
    path.append(step.node.id)

    while not engine.current().type == "end":
        step = engine.advance()
        path.append(step.node.id)

    assert engine.is_terminal()
    return path, engine.variables


def main() -> None:
    # VIP path: amount>100 AND US → 'vip' branch → offer → end
    vip_path, vars_vip = run_path(150, "US")
    assert vip_path == ["greet", "collect", "check", "offer", "end"], vip_path
    assert vars_vip["orderId"] == "A-123"

    # Default path: amount<=100 → 'default' → end2
    default_path, _ = run_path(50, "US")
    assert default_path == ["greet", "collect", "check", "end2"], default_path

    # Default path: US-only rule, non-US caller → 'default'
    intl_path, _ = run_path(150, "DE")
    assert intl_path == ["greet", "collect", "check", "end2"], intl_path

    # safe_eval: comparisons, boolean ops, string equality, fail-closed on unsafe.
    assert safe_eval("amount > 100", {"amount": 150}) is True
    assert safe_eval("amount > 100", {"amount": 50}) is False
    assert safe_eval('tier == "gold" || vip == true', {"tier": "gold", "vip": False}) is True
    assert safe_eval("unknownVar > 5", {}) is False  # unknown name → None → False
    assert safe_eval("__import__('os').system('x')", {}) is False  # unsafe → rejected → False
    assert safe_eval("", {}) is False

    print("PASS — flow engine executes branching flows and evaluates conditions safely.")
    print(f"  VIP path (amount=150,US):     {' → '.join(vip_path)}")
    print(f"  Default path (amount=50):     {' → '.join(default_path)}")
    print(f"  Intl path (amount=150,DE):    {' → '.join(intl_path)}")


if __name__ == "__main__":
    main()
