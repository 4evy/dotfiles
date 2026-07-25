project(
  'tomlc17',
  'c',
  version: 'R260618',
  default_options: ['c_std=c17'],
)

tomlc17_inc = include_directories('src')
tomlc17_lib = static_library(
  'tomlc17',
  'src/tomlc17.c',
  include_directories: tomlc17_inc,
  install: false,
)
tomlc17_dep = declare_dependency(
  include_directories: tomlc17_inc,
  link_with: tomlc17_lib,
)
