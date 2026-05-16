# OpenAI Codex Fast benchmark summary

- Generated: 2026-05-16T11:40:53.308Z
- Normal model: `openai-codex/gpt-5.5`
- Fast model: `openai-codex-fast/gpt-5.5`

## no-thinking

### no-thinking (400 lines, thinking=`off`, 5 pairs)

Validation: `line-count`

| Metric                   |      Normal |        Fast | Paired median change |
| ------------------------ | ----------: | ----------: | -------------------: |
| Wall time                | 40962.89 ms | 28008.54 ms |              -31.09% |
| First output token       |  2764.85 ms |  1896.13 ms |               -25.1% |
| Wall output tok/s        |       50.07 |       72.16 |               43.84% |
| Stream output tok/s      |       53.55 |       77.18 |               46.11% |
| Output tokens            |        2042 |        2017 |                    — |
| Total tokens             |        3493 |        3468 |                    — |
| Observed cost multiplier |          1x |        2.5x |                    — |
| Validation matches       |         5/5 |         5/5 |                    — |

Fast wins: wall 5/5, first-token 5/5, wall throughput 5/5, stream throughput 5/5.

## thinking

### minimal (200 lines, thinking=`minimal`, 5 pairs)

Validation: `exact`

| Metric                   |      Normal |        Fast | Paired median change |
| ------------------------ | ----------: | ----------: | -------------------: |
| Wall time                | 23077.45 ms | 16492.93 ms |              -27.09% |
| First output token       |  2923.04 ms |  2715.15 ms |                0.05% |
| Wall output tok/s        |       45.59 |       63.06 |               38.09% |
| Stream output tok/s      |       52.44 |       74.47 |               45.31% |
| Output tokens            |        1050 |        1049 |                    — |
| Total tokens             |        3509 |        3508 |                    — |
| Observed cost multiplier |          1x |        2.5x |                    — |
| Validation matches       |         5/5 |         5/5 |                    — |

Fast wins: wall 5/5, first-token 2/5, wall throughput 5/5, stream throughput 5/5.

### low (200 lines, thinking=`low`, 5 pairs)

Validation: `exact`

| Metric                   |      Normal |        Fast | Paired median change |
| ------------------------ | ----------: | ----------: | -------------------: |
| Wall time                | 22367.69 ms | 16428.28 ms |              -26.79% |
| First output token       |  2550.49 ms |  2846.72 ms |                3.35% |
| Wall output tok/s        |       46.23 |       63.76 |               37.19% |
| Stream output tok/s      |       51.67 |        77.4 |               50.47% |
| Output tokens            |        1033 |        1049 |                    — |
| Total tokens             |        3492 |        3508 |                    — |
| Observed cost multiplier |          1x |        2.5x |                    — |
| Validation matches       |         5/5 |         5/5 |                    — |

Fast wins: wall 5/5, first-token 0/5, wall throughput 5/5, stream throughput 5/5.

### medium (200 lines, thinking=`medium`, 5 pairs)

Validation: `exact`

| Metric                   |      Normal |        Fast | Paired median change |
| ------------------------ | ----------: | ----------: | -------------------: |
| Wall time                | 22690.12 ms | 16376.61 ms |              -27.11% |
| First output token       |  3740.35 ms |  4094.28 ms |                4.81% |
| Wall output tok/s        |       46.17 |       64.48 |               39.74% |
| Stream output tok/s      |       55.45 |       77.86 |               40.41% |
| Output tokens            |        1046 |        1059 |                    — |
| Total tokens             |        3505 |        3518 |                    — |
| Observed cost multiplier |          1x |        2.5x |                    — |
| Validation matches       |         5/5 |         5/5 |                    — |

Fast wins: wall 5/5, first-token 2/5, wall throughput 5/5, stream throughput 5/5.

### high (200 lines, thinking=`high`, 5 pairs)

Validation: `exact`

| Metric                   |      Normal |        Fast | Paired median change |
| ------------------------ | ----------: | ----------: | -------------------: |
| Wall time                | 23053.13 ms | 17818.71 ms |              -22.71% |
| First output token       |  3167.91 ms |  3488.64 ms |               10.12% |
| Wall output tok/s        |       46.73 |       61.17 |               32.29% |
| Stream output tok/s      |       53.61 |       78.12 |               43.03% |
| Output tokens            |        1066 |        1089 |                    — |
| Total tokens             |        3525 |        3548 |                    — |
| Observed cost multiplier |          1x |        2.5x |                    — |
| Validation matches       |         5/5 |         5/5 |                    — |

Fast wins: wall 4/5, first-token 1/5, wall throughput 4/5, stream throughput 4/5.

### xhigh (200 lines, thinking=`xhigh`, 5 pairs)

Validation: `exact`

| Metric                   |      Normal |        Fast | Paired median change |
| ------------------------ | ----------: | ----------: | -------------------: |
| Wall time                | 24829.88 ms | 16875.18 ms |               -31.4% |
| First output token       |  4554.49 ms |  3398.43 ms |              -29.48% |
| Wall output tok/s        |        46.8 |       65.66 |               40.25% |
| Stream output tok/s      |       56.57 |       82.25 |               44.92% |
| Output tokens            |        1131 |        1111 |                    — |
| Total tokens             |        3590 |        3570 |                    — |
| Observed cost multiplier |          1x |        2.5x |                    — |
| Validation matches       |         5/5 |         5/5 |                    — |

Fast wins: wall 5/5, first-token 5/5, wall throughput 5/5, stream throughput 5/5.
