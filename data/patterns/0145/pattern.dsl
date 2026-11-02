start: mr
R1: 3ch=dc {15dc}@ring ss@top
R2: C2@{{3ch=dc 2dc}@same sk 2ch [3dc@st sk 2ch]x7 ss@top} # groups in every other dc (8 groups on 16 dc)
R3: C2@{2ss ss@sp {2ch=hdc 5dc hdc}@same [{hdc 5dc hdc}@sp]x7 ss@top}
R4: C3@{2ch=hdc 5ch 6sk {dc 5ch dc}@st 5ch 6sk [hdc 5ch 6sk {dc 5ch dc}@st 5ch 6sk]x3 ss@top} # corners and hdc alternate at the petal joins
R5: C4@{3ch=dc {2dc 3ch 3dc}@corner [ch 5dc@sp]x2 ch [{3dc 3ch 3dc}@corner [ch 5dc@sp]x2 ch]x3 ss@top fo}
