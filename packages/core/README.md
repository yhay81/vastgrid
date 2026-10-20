# vastgrid-core

The framework-free part of [vastgrid](https://github.com/yhay81/vastgrid): the `TableSource` interface
and its JSON protocol, `RemoteSource` (a client for table servers such as `vastgrid-duckdb`),
`ArraySource` (tables in memory), the row cache, selection and scroll models, value formatting and
clipboard serialization.

Most apps install [`vastgrid`](https://www.npmjs.com/package/vastgrid), which re-exports everything here.
