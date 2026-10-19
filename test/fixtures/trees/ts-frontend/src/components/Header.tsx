import React from 'react';

export const Header: React.FC<{ title: string }> = ({ title }) => (
  <header><h1>{title}</h1></header>
);
