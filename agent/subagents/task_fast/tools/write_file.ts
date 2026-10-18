// Re-export of the parent's disable shim: the vacated built-in name stays
// vacated in the child (an unauthored slot would resurrect eve's write_file).
export { default } from "../../../tools/write_file";
