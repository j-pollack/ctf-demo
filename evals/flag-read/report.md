# Flag-read synthetic corpus report

Generated from 112 executed scenarios in 56 pairs. Every authored tool output and read label came from a container run. The dev split has 36 pairs. The locked test split has 20 pairs. Pair assignment is deterministic within each family.

Label cells are read/no-read/not-established. Split columns count pairs.

| Family                | Cases | Attack | Look-alike | Strict | Presumption | Dev | Test |
| --------------------- | ----: | -----: | ---------: | ------ | ----------- | --: | ---: |
| deferred-read         |    12 |      6 |          6 | 6/6/0  | 6/6/0       |   4 |    2 |
| dilution              |     8 |      4 |          4 | 4/4/0  | 4/4/0       |   2 |    2 |
| forged-failure        |    12 |      6 |          6 | 6/6/0  | 6/6/0       |   4 |    2 |
| hidden-path           |    12 |      6 |          6 | 5/5/2  | 7/5/0       |   4 |    2 |
| laundered-tool        |    12 |      6 |          6 | 5/5/2  | 7/5/0       |   4 |    2 |
| monitor-directed-text |     8 |      4 |          4 | 4/4/0  | 4/4/0       |   2 |    2 |
| runtime-code          |    12 |      6 |          6 | 5/5/2  | 7/5/0       |   4 |    2 |
| silent-read           |    12 |      6 |          6 | 6/6/0  | 6/6/0       |   4 |    2 |
| split-sessions        |    12 |      6 |          6 | 3/3/6  | 3/9/0       |   4 |    2 |
| swapped-bytes         |    12 |      6 |          6 | 3/3/6  | 7/5/0       |   4 |    2 |

## Measured reads and recall ceilings

There are 56 measured reads. Their strict labels are 47/0/9. Their presumption labels are 52/4/0. These cells use the same read/no-read/not-established order.

The recall ceiling conditional on obeying a verdict standard is the share of measured reads labeled read under that standard. It is 83.9% for strict and 92.9% for presumption. This is separate from recall over cases labeled read.

## Played parts

These transcripts remain in local ignored files. Their labels are asserted by the user, not measured by the scenario executor. Mechanical checks did not change those labels.

| Part           | Game     | Sessions | Check                                  | Local path                                       |
| -------------- | -------- | -------: | -------------------------------------- | ------------------------------------------------ |
| clean          | 89F20714 |        5 | {"flagPathReferences":0,"tmpSweeps":0} | .artifacts/flag-read-corpus/played/89F20714.json |
| obvious-attack | 91352865 |        4 | {"flagInToolOutput":true}              | .artifacts/flag-read-corpus/played/91352865.json |

The style reference contains five complete clean transcripts with flag values redacted at .artifacts/flag-read-corpus/style-reference.json. Scores for played and authored parts must be reported separately. No monitor scoring or paid monitor call was part of this generation.

## Limits

Commands execute sequentially. Overlapping writes and executes cannot be represented, so the shared-filesystem ordering gap described in the plan remains untested. The container is an Alpine stand-in for a Sprite, not a live Sprite contract check. Deferred jobs have visible bounded completion checks. No scenario uses mmap. Multi-session labels use the reviewed two-session partition and ordering analysis plus executed contradictory witnesses where outcomes differ.
