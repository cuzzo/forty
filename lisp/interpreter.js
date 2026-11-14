// The symbols print emits besides a value's own: their names contain spaces, so no program can read them.
export const PRINTED = { open: ' ( ', close: ' ) ', dot: ' . ', newline: ' newline ', full: ' out of memory ' };

// The Lisp interpreter, in forty machine code: McCarthy's eval and apply, with cons cells from a free list and a
// mark-and-sweep collector. Every value is NIL (0), an integer n stored as 2n + 1, or the address of a symbol or a cons
// cell; symbols come before the cons cells in memory, so one comparison tells them apart.
export function interpreter(asm, cells) {
  const { op, routine, label, jmp, ifZero, ifNonZero, car, cdr, setCar, setCdr, call, ret } = asm;
  const { RET, FREE, PROGRAM, NIL, ONE, TWO, sym } = cells;
  const { SYM_BASE, SYM_END, CONS_BASE, CONS_END, CONS_LAST, MARK_BASE, STACK_BASE } = cells;
  const C = 2;

  // The program starts with main's frame at the base of the stack.
  op('LXD', C, STACK_BASE);

  // Evaluate each top-level expression and print its value.
  routine('main', [], ['forms', 'form'], ($) => {
    op('MOV', $.forms, PROGRAM);
    label('next');
    ifZero($.forms, 'end');
    car($.form, $.forms);
    call('eval', $.form, NIL);
    call('print', RET);
    op('PRINT', sym(PRINTED.newline));
    cdr($.forms, $.forms);
    jmp('next');
    label('end');
    op('HALT');
  });

  // An expression's value in an environment: an alist of (symbol . value) pairs.
  routine('eval', ['x', 'env'], ['op', 'f', 'args', 't'], ($) => {
    label('top');
    // NIL and numbers are their own values; a symbol is looked up.
    ifZero($.x, 'self');
    op('%', $.t, $.x, TWO);
    ifNonZero($.t, 'self');
    op('<', $.t, $.x, CONS_BASE);
    ifZero($.t, 'list');
    call('lookup', $.x, $.env);
    ret();
    label('self');
    ret($.x);

    label('list');
    car($.op, $.x);
    cdr($.args, $.x);
    op('==', $.t, $.op, sym('QUOTE'));
    ifZero($.t, 'if');
    car(RET, $.args);
    ret();

    label('if');
    op('==', $.t, $.op, sym('IF'));
    ifZero($.t, 'lambda');
    car($.t, $.args);
    call('eval', $.t, $.env);
    cdr($.args, $.args);
    ifNonZero(RET, 'then');
    cdr($.args, $.args);
    label('then');
    // The branch taken is evaluated in this same frame: a tail call.
    car($.x, $.args);
    jmp('top');

    // A closure is (lambda-expression . environment).
    label('lambda');
    op('==', $.t, $.op, sym('LAMBDA'));
    ifZero($.t, 'define');
    call('cons', $.x, $.env);
    ret();

    // A symbol's second word is its global value.
    label('define');
    op('==', $.t, $.op, sym('DEFINE'));
    ifZero($.t, 'call');
    car($.f, $.args);
    cdr($.t, $.args);
    car($.t, $.t);
    call('eval', $.t, $.env);
    setCdr($.f, RET);
    ret($.f);

    label('call');
    call('eval', $.op, $.env);
    op('MOV', $.f, RET);
    call('evlis', $.args, $.env);
    op('MOV', $.args, RET);
    op('%', $.t, $.f, TWO);
    ifNonZero($.t, 'primitive');
    op('<', $.t, $.f, CONS_BASE);
    ifNonZero($.t, 'primitive');
    // A closure, (lambda-expression . environment): bind its parameters in its environment, then evaluate its body
    // in this same frame, so that a call in tail position does not grow the stack.
    car($.t, $.f);
    cdr($.t, $.t);
    car($.op, $.t);
    cdr($.t, $.t);
    car($.x, $.t);
    cdr($.t, $.f);
    call('pairlis', $.op, $.args, $.t);
    op('MOV', $.env, RET);
    jmp('top');
    label('primitive');
    call('apply', $.f, $.args);
    ret();
  });

  // A list of each expression's value, in order.
  routine('evlis', ['list', 'env'], ['head', 'tail', 't'], ($) => {
    op('MOV', $.head, NIL);
    op('MOV', $.tail, NIL);
    label('next');
    ifZero($.list, 'done');
    car($.t, $.list);
    call('eval', $.t, $.env);
    call('cons', RET, NIL);
    ifNonZero($.tail, 'append');
    op('MOV', $.head, RET);
    jmp('linked');
    label('append');
    setCdr($.tail, RET);
    label('linked');
    op('MOV', $.tail, RET);
    cdr($.list, $.list);
    jmp('next');
    label('done');
    ret($.head);
  });

  // Integers are stored as 2n + 1, so a sum or difference needs one correction, and a product a few.
  const PRIMITIVES = {
    CAR: ($) => { car(RET, $.a); ret(); },
    CDR: ($) => { cdr(RET, $.a); ret(); },
    CONS: ($) => { call('cons', $.a, $.b); ret(); },
    ATOM: ($) => {
      op('<', $.t, $.a, CONS_BASE);
      ifNonZero($.t, 'true');
      op('%', $.t, $.a, TWO);
      ifNonZero($.t, 'true');
      jmp('false');
    },
    EQ: ($) => {
      op('==', $.t, $.a, $.b);
      ifNonZero($.t, 'true');
      jmp('false');
    },
    '+': ($) => {
      op('+', $.t, $.a, $.b);
      op('-', RET, $.t, ONE);
      ret();
    },
    '-': ($) => {
      op('-', $.t, $.a, $.b);
      op('+', RET, $.t, ONE);
      ret();
    },
    '*': ($) => {
      op('-', $.a, $.a, ONE);
      op('/', $.a, $.a, TWO);
      op('-', $.b, $.b, ONE);
      op('*', $.t, $.a, $.b);
      op('+', RET, $.t, ONE);
      ret();
    },
    '<': ($) => {
      op('<', $.t, $.a, $.b);
      ifNonZero($.t, 'true');
      jmp('false');
    },
  };

  // A primitive, which is its own symbol, applied to a list of values. Anything else is not a function: NIL.
  routine('apply', ['f', 'args'], ['a', 'b', 't'], ($) => {
    car($.a, $.args);
    cdr($.t, $.args);
    car($.b, $.t);
    for (const [name, body] of Object.entries(PRIMITIVES)) {
      op('==', $.t, $.f, sym(name));
      ifZero($.t, `not ${name}`);
      body($);
      label(`not ${name}`);
    }
    label('false');
    ret(NIL);
    label('true');
    ret(sym('T'));
  });

  // The environment with each name bound to its value, (name . value) pairs in front.
  routine('pairlis', ['names', 'values', 'env'], ['t', 'u'], ($) => {
    label('next');
    ifZero($.names, 'done');
    car($.t, $.names);
    car($.u, $.values);
    call('cons', $.t, $.u);
    call('cons', RET, $.env);
    op('MOV', $.env, RET);
    cdr($.names, $.names);
    cdr($.values, $.values);
    jmp('next');
    label('done');
    ret($.env);
  });

  // A symbol's value: its first binding in the environment, or else its global value.
  routine('lookup', ['symbol', 'env'], ['pair', 't'], ($) => {
    label('next');
    ifZero($.env, 'global');
    car($.pair, $.env);
    car($.t, $.pair);
    op('==', $.t, $.t, $.symbol);
    ifZero($.t, 'on');
    cdr(RET, $.pair);
    ret();
    label('on');
    cdr($.env, $.env);
    jmp('next');
    label('global');
    cdr(RET, $.symbol);
    ret();
  });

  // A fresh cons cell from the free list, collecting garbage when the list is empty.
  routine('cons', ['car', 'cdr'], [], ($) => {
    ifNonZero(FREE, 'take');
    call('collect');
    ifNonZero(FREE, 'take');
    op('PRINT', sym(PRINTED.full));
    op('HALT');
    label('take');
    op('MOV', RET, FREE);
    cdr(FREE, FREE);
    setCar(RET, $.car);
    setCdr(RET, $.cdr);
    ret();
  });

  // Mark every cell reachable from the roots, then sweep the unmarked ones onto the free list. The roots are every
  // symbol's global value, RET, and every word on the stack below this frame: whatever looks like a cons cell's
  // address is treated as one, which can keep garbage alive but never frees a live cell.
  routine('collect', [], ['p', 't', 'top'], ($) => {
    op('MOV', $.p, SYM_BASE);
    label('symbols');
    op('<', $.t, $.p, SYM_END);
    ifZero($.t, 'stack');
    cdr($.t, $.p);
    call('mark', $.t);
    op('+', $.p, $.p, TWO);
    jmp('symbols');

    label('stack');
    call('mark', RET);
    op('MOV', $.p, STACK_BASE);
    op('PXD', $.top, C);
    label('word');
    op('<', $.t, $.p, $.top);
    ifZero($.t, 'sweep');
    op('LOAD_IND', $.t, $.p);
    call('mark', $.t);
    op('+', $.p, $.p, ONE);
    jmp('word');

    // From the last cell to the first, so the free list comes out in address order.
    label('sweep');
    op('MOV', FREE, NIL);
    op('MOV', $.p, CONS_LAST);
    label('cell');
    op('<', $.t, $.p, CONS_BASE);
    ifNonZero($.t, 'done');
    op('-', $.top, $.p, CONS_BASE);
    op('/', $.top, $.top, TWO);
    op('+', $.top, $.top, MARK_BASE);
    op('LOAD_IND', $.t, $.top);
    ifZero($.t, 'free');
    op('STORE_IND', $.top, NIL);
    jmp('previous');
    label('free');
    setCar($.p, NIL);
    setCdr($.p, FREE);
    op('MOV', FREE, $.p);
    label('previous');
    op('-', $.p, $.p, TWO);
    jmp('cell');
    label('done');
    ret();
  });

  // Mark a cell, then everything its car reaches (recursively) and its cdr reaches (in a loop). Only an even address
  // in the cons cells is a cell: integers are odd, and return addresses and links point elsewhere.
  routine('mark', ['x'], ['t', 'mark'], ($) => {
    label('top');
    op('<', $.t, $.x, CONS_BASE);
    ifNonZero($.t, 'done');
    op('<', $.t, $.x, CONS_END);
    ifZero($.t, 'done');
    op('%', $.t, $.x, TWO);
    ifNonZero($.t, 'done');
    op('-', $.mark, $.x, CONS_BASE);
    op('/', $.mark, $.mark, TWO);
    op('+', $.mark, $.mark, MARK_BASE);
    op('LOAD_IND', $.t, $.mark);
    ifNonZero($.t, 'done');
    op('STORE_IND', $.mark, ONE);
    car($.t, $.x);
    call('mark', $.t);
    cdr($.x, $.x);
    jmp('top');
    label('done');
    ret();
  });

  // Print a value as a sequence of symbols and numbers, with ( ) and . as symbols of their own.
  routine('print', ['x'], ['t'], ($) => {
    ifZero($.x, 'atom');
    op('%', $.t, $.x, TWO);
    ifNonZero($.t, 'atom');
    op('<', $.t, $.x, CONS_BASE);
    ifNonZero($.t, 'atom');
    op('PRINT', sym(PRINTED.open));
    label('item');
    car($.t, $.x);
    call('print', $.t);
    cdr($.x, $.x);
    ifZero($.x, 'close');
    op('%', $.t, $.x, TWO);
    ifNonZero($.t, 'dotted');
    op('<', $.t, $.x, CONS_BASE);
    ifNonZero($.t, 'dotted');
    jmp('item');
    label('dotted');
    op('PRINT', sym(PRINTED.dot));
    op('PRINT', $.x);
    label('close');
    op('PRINT', sym(PRINTED.close));
    ret();
    label('atom');
    op('PRINT', $.x);
    ret();
  });
}
