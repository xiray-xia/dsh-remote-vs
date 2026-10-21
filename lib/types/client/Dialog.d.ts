/**
 * Small inline input dialog (new file / folder / rename). Rendered as a
 * fixed overlay card; Enter confirms, Escape cancels.
 */
import { type ReactNode } from 'react';
export declare function InputDialog(props: {
    title: string;
    label: string;
    initial?: string;
    placeholder?: string;
    okText?: string;
    onOk: (value: string) => void;
    onCancel: () => void;
}): ReactNode;
