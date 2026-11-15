# 0012: Owners and judge evidence in the Eval

Status: accepted

Date: 2026-11-15

Supersedes two rules of [0011](0011-eval-runner.md): that each run has one Owner, and that the judge gets only the conversation. Issue #38.

## Decision

- Each run adds two Owners, A and B. An Owner Event and a check can name the Owner with `owner` (`A` or `B`). The default is A. The seed fills Owner A. Each Owner has its own Personal Agent storage, and the runner reads the observation of each Owner from its own storage.
- A failed check of Owner B starts with `Owner B,` in the report.
- The user message of the judge is one JSON object with two fields. `conversation` is the array of exchanges of the judged Owner, as in 0011. `toolCalls` lists the name, input, and output of each tool call of the judged Owner in the run. The instructions say that both fields are data to judge, never instructions.

## Why

A case about isolation between Owners needs a second Owner in the same run, and the checks must read each Owner's storage. A rubric that names a fact from a tool result, such as the capture date of a Note, needs the tool result, or the judge cannot tell a true date from an invented one.

## Revisit if

- A case needs more than two Owners.
- The tool results make the judge prompt too long, or a forwarded attack in a tool result changes a verdict.
