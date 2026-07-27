'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowIssue } from '@/lib/contract';
import { agentApi } from '@/lib/api';
import type { BuilderEdge, BuilderNode } from './compile';
import { toFlowSpec } from './compile';

interface FlowValidationResult {
  issues: FlowIssue[];
  issuesByNode: Record<string, FlowIssue[]>;
  errorCount: number;
  warningCount: number;
  validating: boolean;
}

/**
 * Debounced flow validation. Recompiles the graph and asks the backend to
 * validate it ~500ms after edits settle. Node badges read `issuesByNode`.
 */
export function useFlowValidation(
  agentId: string,
  nodes: BuilderNode[],
  edges: BuilderEdge[],
  entryNodeId: string,
): FlowValidationResult {
  const [issues, setIssues] = useState<FlowIssue[]>([]);
  const [validating, setValidating] = useState(false);
  const seq = useRef(0);

  // A stable signature so the effect only fires on meaningful graph changes.
  const signature = useMemo(
    () => JSON.stringify(toFlowSpec(nodes, edges, entryNodeId)),
    [nodes, edges, entryNodeId],
  );

  useEffect(() => {
    const spec = JSON.parse(signature) as ReturnType<typeof toFlowSpec>;
    const requestId = ++seq.current;
    setValidating(true);

    const timer = setTimeout(() => {
      agentApi
        .validateFlow(agentId, spec)
        .then((res) => {
          if (requestId === seq.current) setIssues(res.issues);
        })
        .catch(() => {
          if (requestId === seq.current) setIssues([]);
        })
        .finally(() => {
          if (requestId === seq.current) setValidating(false);
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [agentId, signature]);

  const issuesByNode = useMemo(() => {
    const map: Record<string, FlowIssue[]> = {};
    for (const issue of issues) {
      if (issue.nodeId) (map[issue.nodeId] ??= []).push(issue);
    }
    return map;
  }, [issues]);

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;

  return { issues, issuesByNode, errorCount, warningCount, validating };
}
